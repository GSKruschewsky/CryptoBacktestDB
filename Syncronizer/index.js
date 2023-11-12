import WebSocket from 'ws';
import Big from 'big.js';
import fetch from 'node-fetch';
import crypto from "crypto";
import exchanges from './Exchanges/config.json' assert { type: "json" };
import dotenv from "dotenv";
dotenv.config();

const args = process.argv.slice(2); // Get command-line arguments, starting from index 2
if (args.length !== 3) {
  console.log("Usage: npm sync <exchange> <base> <quote>");
  process.exit(1);
}

// Melhorias para fazer:
// [*] Processar trade id para evitar trades duplicados na sincronização inicial.
// [*] Binance-spot: use pagination on trades.
// [*] Kraken-spot: use pagination on trades.

// Exchanges to add:
// [*] kraken-spot
// [*] coinbase-spot
// [ ] gemini-spot
// [ ] bitstamp-spot
// [ ] lmax_digital-spot

// [*] binance-spot
// [ ] okx-spot
// [ ] htx-spot (huobi)
// [ ] mexc-spot
// [ ] bybit-spot

let exchange = args[0];
let base = args[1];
let quote = args[2];

let markets = null;

let orderbook = null;
let orderbook_upd_cache = [];

let trades = null;
let trades_upd_cache = [];

let exc = null;
let api = {};
let market = {};
let ws_req_nonce = 0;
let authenticate = null;

function apply_orderbook_upd (upd) {
  // console.log('Book upd:',upd);

  // Validate updates.
  if (upd.last_update_nonce && upd.last_update_nonce <= orderbook.last_update_nonce)
    return;

  if (upd.first_update_nonce) {
    if (orderbook.received_first_update) {
      if (upd.first_update_nonce != orderbook.last_update_nonce + 1)
        return;
    } else {
      if (upd.first_update_nonce > orderbook.last_update_nonce + 1)
        return;
    }
  }
  
  // Apply updates.
  [ 'asks', 'bids' ].forEach(side => {
    upd[side].forEach(([ price, amount ]) => {
      if (Big(amount).eq(0)) {
        delete orderbook[side][price];
      } else {
        orderbook[side][price] = amount;
      }
    });
  });

  // Set other orderbook vars.
  orderbook.received_first_update = true;
  orderbook.timestamp = upd.timestamp;
  orderbook.last_update_nonce = upd.last_update_nonce;
}

function handle_orderbook_msg (msg, info, _prom) {
  // console.log('Book update:',msg);
  if (msg.is_snapshot) {
    orderbook = {
      asks: Object.fromEntries(msg.asks),
      bids: Object.fromEntries(msg.bids),
      timestamp: msg.timestamp,
      last_update_nonce: msg.last_update_nonce
    };

    if ((!info.orderbook.is_subscribed) && exc.rest.endpoints.orderbook == undefined) {
      info.orderbook.is_subscribed = true;

      // Se também já estiver incrito a 'trades' resolve a promessa.
      if (info.trades.is_subscribed && _prom) _prom.resolve();
    }

  } else {
    if (orderbook == null || orderbook_upd_cache.length > 0) {
      orderbook_upd_cache.push(msg);
    } else {
      apply_orderbook_upd(msg);
    }
  }
}

function handle_trades_msg (msg) {
  // console.log('Trades update:',msg);
  if (trades == null || trades_upd_cache.length > 0) {
    // console.log('cached.');
    trades_upd_cache = [ ...trades_upd_cache, ...msg ];
  } else {
    // console.log('added.');
    trades = [ ...trades, ...msg ];
  }
}

function format_orderbook_msg (msg) {
  // Essa função deve receber a mensagem de 'orderbook' e formatar para o padrão abaixo.
  // {
  //   asks: [ [ price, amount ], ... ],
  //   bids: [ [ price, amount ], ... ],
  //   timestamp: <timestamp in miliseconds>,
  //   is_snapshot: <true | false>,
  //   first_update_nonce: <upd nonce here>, *only if required.
  //   last_update_nonce: <upd nonce here>, *only if required.
  // }
  // console.log('Book msg:',msg);
  const _orderbook = exc.ws.subcriptions.orderbook;

  // Define if this orderbook message is an updade or a snapshot.
  let is_snapshot = false;
  if (msg[_orderbook.snapshot?.identifier_key] != undefined && 
  (_orderbook.snapshot?.identifier_value == undefined || 
  msg[_orderbook.snapshot.identifier_key] == _orderbook.snapshot.identifier_value)) {
    is_snapshot = (
      _orderbook.snapshot?.identifier_value == undefined ||
      msg[_orderbook.snapshot?.identifier_key] == _orderbook.snapshot?.identifier_value
    );
  }

  // Construct the formatted message.
  let updates = (msg[_orderbook.update.updates_inside] || msg);
  let asks = [];
  let bids = [];

  if ((!is_snapshot) && _orderbook.update.asks_and_bids_together) {
    updates.forEach(x => {
      if (x[_orderbook.update.pl.is_bids_key] == _orderbook.update.pl.is_bids_value)
        bids.push([ x[_orderbook.update.pl.price], x[_orderbook.update.pl.amount] ]);
      else
        asks.push([ x[_orderbook.update.pl.price], x[_orderbook.update.pl.amount] ]);
    });
  } else {
    asks = (updates[(is_snapshot && _orderbook.snapshot?.asks) || _orderbook.update.asks] || [])
    .map(x => [ 
      x[(is_snapshot && _orderbook.snapshot?.pl?.price) || _orderbook.update.pl.price], 
      x[(is_snapshot && _orderbook.snapshot?.pl?.amount) || _orderbook.update.pl.amount]
    ]);
    
    bids = (updates[(is_snapshot && _orderbook.snapshot?.bids) || _orderbook.update.bids] || [])
    .map(x => [ 
      x[(is_snapshot && _orderbook.snapshot?.pl?.price) || _orderbook.update.pl.price], 
      x[(is_snapshot && _orderbook.snapshot?.pl?.amount) || _orderbook.update.pl.amount] 
    ]);
  }

  let formatted = { asks, bids, is_snapshot };

  // Define the timestamp if possible.
  if (_orderbook.update.timestamp || _orderbook.snapshot?.timestamp) {
    formatted.timestamp = msg[
      (is_snapshot && _orderbook.snapshot?.timestamp) || 
      _orderbook.update.timestamp
    ];

    if (exc.timestamp_ISO_format) 
      formatted.timestamp = new Date(formatted.timestamp).getTime();
    else if (exc.timestamp_in_seconds) 
      formatted.timestamp *= 1e3;

  } else if (_orderbook.snapshot?.pl?.timestamp || _orderbook.update.pl?.timestamp) {
    let timestamp_asks = (updates[(is_snapshot && _orderbook.snapshot?.asks) || _orderbook.update.asks] || [])
    .map(x => x[
      (is_snapshot && _orderbook.snapshot?.pl?.timestamp) || 
      _orderbook.update.pl.timestamp
    ]);
    let max_timestamp_asks = Math.max(...timestamp_asks);

    let timestamp_bids = (updates[(is_snapshot && _orderbook.snapshot?.bids) || _orderbook.update.bids] || [])
    .map(x => x[
      (is_snapshot && _orderbook.snapshot?.pl?.timestamp) || 
      _orderbook.update.pl.timestamp
    ]);
    let max_timestamp_bids = Math.max(...timestamp_bids);

    formatted.timestamp = Math.max(max_timestamp_asks, max_timestamp_bids);
    
    if (exc.timestamp_ISO_format) 
      formatted.timestamp = new Date(formatted.timestamp).getTime();
    else if (exc.timestamp_in_seconds) 
      formatted.timestamp *= 1e3;
  }

  // Set first and last update_nonces if required.
  if (_orderbook.update.first_upd_nonce_key)
    formatted.first_update_nonce = msg[_orderbook.update.first_upd_nonce_key];
  
  if (_orderbook.update.last_upd_nonce_key)
    formatted.last_update_nonce = msg[_orderbook.update.last_upd_nonce_key];

  // Retorna a mensagem formatada.
  return formatted;
}

function format_trades_msg (msg) {
  // Essa função deve receber a mensagem de 'trades' e formatar para o padrão abaixo.
  // (O array deve estar formatado em ordem crescente ordenado pelo 'timestamp')
  // [
  //   {
  //     timestamp: <trade time in ms>,
  //     is_buy: <true | false>,
  //     price: <trade price>,
  //     amount: <trade amount in base asset>
  //   },
  //   ...
  // ]
  // console.log('Trades msg:',msg);
  
  // Se recebe cada trade como um objeto unico, insere esse trade dentro de um array.
  if (exc.ws.subcriptions.trades.update.receive_separately_trades_as_obj) 
    msg = [ msg ];

  // Retorna trades formatados.
  return msg.map(t => {
    let timestamp = t[exc.ws.subcriptions.trades.update.timestamp];
  
    if (exc.timestamp_in_seconds)
      timestamp *= 1e3;
    else if (exc.timestamp_ISO_format)
      timestamp = new Date(timestamp).getTime();
    
    let obj = {
      timestamp,
      is_buy: (t[exc.ws.subcriptions.trades.update.is_buy_key] == exc.ws.subcriptions.trades.update.is_buy_value),
      price: t[exc.ws.subcriptions.trades.update.price],
      amount: t[exc.ws.subcriptions.trades.update.amount]
    };

    if (exc.ws.subcriptions.trades.update.trade_id_key != undefined)
      obj.trade_id = t[exc.ws.subcriptions.trades.update.trade_id_key];

    if (exc.trades_custom_id)
      obj.custom_id = Object.values(t).filter(v => v != obj.trade_id).join('');

    return obj;
  });
}

function connect () {
  console.log('Connecting to '+exchange+' '+market.ws+'...');

  // Reseta as variaveis.
  orderbook = null;
  orderbook_upd_cache = [];
  trades = null;
  trades_upd_cache = [];

  // Cria objeto para armazenar informações a respeito de 'orderbook' e 'trades'.
  let info = { orderbook: {}, trades: {} };

  // Cira uma variaveis de controle para 'ping loop'.
  let ping_loop_interval;
  let keep_alive = true;

  // Cria uma promessa 'prom' e uma variavél '_prom' para futuramente resolver ou rejeitar a promessa.
  let _prom = null;
  let prom = new Promise((resolve, reject) => _prom = { resolve, reject })
  .finally(() => _prom = null); // Ao finalizar a promesa '_prom' volta ser NULL.

  // Cria um timeout para rejeitar a promessa caso a mesma não resolva logo.
  setTimeout(_prom.reject, (exc.ws.timeout || 5000), "TIMEOUT.");

  // Cria uma conexão com o websocket da exchange.
  const ws = new WebSocket(exc.ws.url);

  // Quando recebermos um ping, enviaremos um pong.
  ws.on('ping', ws.pong);

  // Quando recebermos um pong, manteremos a conexão aberta.
  ws.on('pong', () => keep_alive = true);

  // Quando perdemos a conexão iremos tentar nos conectar novamente.
  ws.on('close', () => {
    // Reseta as variaveis.
    orderbook = null;
    orderbook_upd_cache = [];
    trades = null;
    trades_upd_cache = [];

    clearInterval(ping_loop_interval);
    connect();
  });

  // Quando recebermos um erro do WebSocket, iremos logar o erro e encerrar o processo.
  ws.on('error', err => {
    // Também devemos enviar um e-mail aqui.
    console.log('WebSocket error:',err);
    process.exit();
  });

  // Quando a conexão abrir devemos nos escrever as atualizações de 'orderbook' e 'trades' da exchange.
  ws.on('open', () => {
    console.log('[!] Connected.');

    // Inicia 'ping loop'.
    ping_loop_interval = setInterval(() => {
      if (!keep_alive) {
        console.log('[E] O servior não responseu ao nosso ping em até '+((exc.ws.timeout || 5000) / 1e3)+' segundos.');
        ws.terminate();
      }
      keep_alive = false;
      ws.ping();
    }, (exc.ws.timeout || 5000));

    // Envia pedido de subscriçao de oerderbook.
    let orderbook_sub_req = exc.ws.subcriptions.orderbook.request
    .replace('<market>', market.ws)
    .replace('<ws_req_id>', ++ws_req_nonce);

    // Autentica requisição de subscrição do orderbook se necessario.
    if (exc.ws.subcriptions.orderbook.require_auth) {
      const { signature, sign_nonce } = authenticate();
      
      orderbook_sub_req = orderbook_sub_req
      .replace('<api_key>', api.key)
      .replace('<api_pass>', api.pass)
      .replace('<sign_nonce>', sign_nonce)
      .replace('<signature>', signature);
    }

    ws.send(orderbook_sub_req);
    
    info.orderbook.req_id = exc.ws.subcriptions.orderbook.response.id_value || ws_req_nonce;
    
    // Envia pedido de subscrição de trades.
    let trades_sub_req = exc.ws.subcriptions.trades.request
    .replace('<market>', market.ws)
    .replace('<ws_req_id>', ++ws_req_nonce);

    ws.send(trades_sub_req);
    
    info.trades.req_id = exc.ws.subcriptions.trades.response.id_value || ws_req_nonce;
  });

  // Finalmente, aqui processaremos os dados recebidos do servidor.
  ws.on('message', msg => {
    // Try to parse mesage as a JSON.
    try { msg = JSON.parse(msg); } catch (e) { msg = msg.toString(); }

    // console.log('WebSocket message:',msg);

    // Checks if msg is an error.
    if (msg?.[exc.ws.error.key] != undefined && 
    (exc.ws.error.value == undefined || msg[exc.ws.error.key] == exc.ws.error.value)) {
      console.log('[E] ('+exchange+' '+market.ws+') WebSocket API Error:',msg);
      ws.terminate();
      return;
    }

    // Handle 'trades' subscription response.
    if (!info.trades.is_subscribed) {
      let this_is_trades_subscription_response = false;

      if (exc.ws.subcriptions.trades.response.acum_list) {
        if (msg[exc.ws.subcriptions.trades.response.list_id_key] == exc.ws.subcriptions.trades.response.list_id_value &&
        (msg[exc.ws.subcriptions.trades.response.list_inside] || msg).some(
          x => x[exc.ws.subcriptions.trades.response.id] == exc.ws.subcriptions.trades.response.id_value
        ))
          this_is_trades_subscription_response = true;

      } else if (exc.ws.subcriptions.trades.response.id.split('.').reduce((f, k) => f = f?.[k], msg) == info.trades.req_id) {
        this_is_trades_subscription_response = true;
      }

      if (this_is_trades_subscription_response) {
        info.trades.is_subscribed = true;
    
        if (exc.ws.subcriptions.trades.response.channel_id_key)
          info.trades.channel_id = msg[exc.ws.subcriptions.trades.response.channel_id_key];
        else if (exc.ws.subcriptions.trades.update.channel_id)
          info.trades.channel_id = exc.ws.subcriptions.trades.update.channel_id.replace('<market>', market.ws);
        else
          throw "Neither 'trades.response.channel_id_key' or 'trades.update.channel_id' are defined.";
        
        // Se também já estiver incrito a 'orderbook' resolve a promessa.
        if (info.orderbook.is_subscribed && _prom) _prom.resolve();
  
        return console.log('[!] Successfully subscribed to trades updates.');
      }
    }

    // Handle 'orderbook' subscription response.
    if (!info.orderbook.is_subscribed) {
      let this_is_orderbook_subscription_response = false;

      if (exc.ws.subcriptions.orderbook.response.acum_list) {
        if (msg[exc.ws.subcriptions.orderbook.response.list_id_key] == exc.ws.subcriptions.orderbook.response.list_id_value &&
        (msg[exc.ws.subcriptions.orderbook.response.list_inside] || msg).some(
          x => x[exc.ws.subcriptions.orderbook.response.id] == exc.ws.subcriptions.orderbook.response.id_value
        ))
          this_is_orderbook_subscription_response = true;
      
      } else if (exc.ws.subcriptions.orderbook.response.id.split('.').reduce((f, k) => f = f?.[k], msg) == info.orderbook.req_id) {
        this_is_orderbook_subscription_response = true;
      }

      if (this_is_orderbook_subscription_response) {
        if (exc.ws.subcriptions.orderbook.response.channel_id_key)
          info.orderbook.channel_id = msg[exc.ws.subcriptions.orderbook.response.channel_id_key];
        else if (exc.ws.subcriptions.orderbook.update.channel_id)
          info.orderbook.channel_id = exc.ws.subcriptions.orderbook.update.channel_id.replace('<market>', market.ws);
        else
          throw "Neither 'orderbook.response.channel_id_key' or 'orderbook.update.channel_id' are defined.";

        if (exc.rest.endpoints.orderbook != undefined) {
          info.orderbook.is_subscribed = true;

          // Se também já estiver incrito a 'trades' resolve a promessa.
          if (info.trades.is_subscribed && _prom) _prom.resolve();
        }

        return console.log('[!] Successfully subscribed to orderbook updates.');
      }
    }

    // Handle orderbook message.
    let _channel_id = null;
    if (!isNaN(exc.ws.subcriptions.orderbook.update.channel_id_key)) {
      if (Big(exc.ws.subcriptions.orderbook.update.channel_id_key).abs().gt(msg.length || -1))
        _channel_id = undefined
      else
        _channel_id = msg.slice(exc.ws.subcriptions.orderbook.update.channel_id_key)[0]
    } else {
      _channel_id = msg[exc.ws.subcriptions.orderbook.update.channel_id_key];
    }
    if (info.orderbook.channel_id && (
      _channel_id == info.orderbook.channel_id || 
      (exc.ws.subcriptions.orderbook?.snapshot?.channel_id != undefined &&
      _channel_id == exc.ws.subcriptions.orderbook.snapshot.channel_id)
    )) {
      if (exc.ws.subcriptions.orderbook.update.data_inside?.includes(',')) {
        msg
        .slice(...exc.ws.subcriptions.orderbook.update.data_inside.split(','))
        .forEach(x => handle_orderbook_msg(format_orderbook_msg(x), info, _prom));
        return;
      }

      return handle_orderbook_msg(
        format_orderbook_msg(msg?.[exc.ws.subcriptions.orderbook.update.data_inside] || msg),
        info,
        _prom
      );
    }
    
    // Handle trades message.
    _channel_id = null;
    if (!isNaN(exc.ws.subcriptions.trades.update.channel_id_key)) {
      if (Big(exc.ws.subcriptions.trades.update.channel_id_key).abs().gt(msg.length || -1))
        _channel_id = undefined
      else
        _channel_id = msg.slice(exc.ws.subcriptions.trades.update.channel_id_key)[0]
    } else {
      _channel_id = msg[exc.ws.subcriptions.trades.update.channel_id_key];
    }
    if (info.trades.channel_id && _channel_id == info.trades.channel_id) 
      return handle_trades_msg(
        format_trades_msg(msg?.[exc.ws.subcriptions.trades.update.data_inside] || msg)
      );
    
    // WebSocket messages to ignore.
    if (exc.ws.msgs_to_ignore != undefined &&
    exc.ws.msgs_to_ignore.some(([ key, value ]) => msg[key] && (value == undefined || msg[key] == value)))
      return;

    // Recebemos uma mensagem inesperada do servidor, devemos logar e finalizar o processo.
    console.log('WebSocket ('+exchange+' '+market.ws+') unexpected message:',msg);
    process.exit();
  });

  // Então retornamos a promessa criada.
  return prom;
}

async function syncronizer () {
  // Validate a exchange
  exchange = exchange.toLowerCase();
  if (!Object.keys(exchanges).includes(exchange))
    throw 'Exchange desconhecida';

  // Define o obejto 'exchange' que será usado.
  exc = exchanges[exchange];

  // Cria a função de autenticação caso necessário.
  if (exc.ws?.auth != undefined) {
    // Obtem chave da API apartir das variavéis de ambiente.
    api.key = process.env[exchange.toUpperCase()+'_API_KEY'];
    api.scr = process.env[exchange.toUpperCase()+'_API_SECRET'];
    api.pass = process.env[exchange.toUpperCase()+'_API_PASSPHRASE'];

    // Define a função de autenticação.
    authenticate = () => {
      let nonce = eval(exc.ws.auth.nonce_to_eval); // Por enquanto única opção.

      let message = exc.ws.auth.message
      .replace('<nonce>', nonce);

      let signature = crypto.createHmac(
        exc.ws.auth.algo, 
        exc.ws.auth.secret_buffer_from != undefined ? Buffer.from(api.scr, exc.ws.auth.secret_buffer_from) : api.scr
      )
      .update(message)
      .digest(exc.ws.auth.digest_to);

      return { signature, sign_nonce: nonce };
    };
  }

  // Define o mercado.
  if (exc.separator != undefined) {
    exc.rest.separator = exc.separator;
    exc.ws.separator = exc.separator;
  }
  
  if (exc.is_market_upper){
    exc.rest.is_market_upper = true;
    exc.ws.is_market_upper = true;
  }

  market = {
    rest: base + exc.rest.separator + quote,
    ws: base + exc.ws.separator + quote
  }

  if (exc.rest.is_market_upper)
    market.rest = market.rest.toUpperCase();
  else
    market.rest = market.rest.toLowerCase();

  if (exc.ws.is_market_upper)
    market.ws = market.ws.toUpperCase();
  else
    market.ws = market.ws.toLowerCase();

  // Obtem os pares disponíveis da exchange.
  let raw_markets = null;
  try {
    await Promise.race([
      new Promise((resolve, reject) => setTimeout(reject, (exc.rest.timeout || 5000))),
      fetch(
        (exc.rest.url + exc.rest.endpoints.available_pairs.path)
        .replace('<market>', market.rest)
      )
      .then(r => r.json())
      .then(r => {
        if (r?.[exc.rest.error.key] != undefined) {
          let really_an_error = false;
          
          if (exc.rest.error.is_array) {
            if (r[exc.rest.error.key].length > 0)
              really_an_error = true;
          } else {
            if (exc.rest.error.value == undefined || r[exc.rest.error.key] == exc.rest.error.value)
              really_an_error = true;
          }

          if (really_an_error) throw { endpoint: 'available_pairs', error: r };
        }

        r = (r?.[exc.rest.endpoints.available_pairs.response.data_inside] || r);

        if (!Array.isArray(r)) 
          raw_markets = Object.keys(r).reduce((sum, k) => [ ...sum, { __key: k, ...r[k] } ], []);
        else 
          raw_markets = r;
      })
    ]);
  } catch (err) {
    console.log('[E] Getting exchange markets:',err);
    throw 'Failed to get exchange markets.'
  }
  
  // Set markets by filtering raw active markets.
  markets = raw_markets
  .filter(m => 
    m?.[exc.rest.endpoints.available_pairs.response.status_key] == null || 
    m[exc.rest.endpoints.available_pairs.response.status_key] == exc.rest.endpoints.available_pairs.response.status_active
  )
  .map(m => (m?.[exc.rest.endpoints.available_pairs.response.symbol] || m));

  // console.log('markets:',markets);
  // console.log('market:',market);

  // Valida o mercado
  if (!markets.includes(market.rest))
    throw 'Mercado selecionado é inválido ou não esta ativo no momento.';

  // Tenta se conectar e se inscrever as atualizações da exchange.
  try { await connect(); } 
  catch (err) {
    console.log('[E] Connecting:',err);
    throw 'Connection failed.'
  }

  // Define variables to store the initial snapshot.
  let init_trades = null;
  let init_orderbook = null;

  // 'since' represents the start of the second that we are syncing.
  let since = Math.floor(Date.now() / 1e3);
  if (!exc.timestamp_in_seconds) since *= 1e3; 

  // Set promise to get initial trades snapshot.
  let _proms = [
    fetch(
      (exc.rest.url + exc.rest.endpoints.trades.path)
      .replace('<market>', market.rest)
      .replace('<since>', since)
    )
    .then(r => r.json())
    .then(r => {
      if (r?.[exc.rest.error.key] != undefined) {
        let really_an_error = false;
        
        if (exc.rest.error.is_array) {
          if (r[exc.rest.error.key].length > 0)
            really_an_error = true;
        } else {
          if (exc.rest.error.value == undefined || r[exc.rest.error.key] == exc.rest.error.value)
            really_an_error = true;
        }

        if (really_an_error) throw { endpoint: 'available_pairs', error: r };
      }
        
      // console.log('init_trades response:',r);
      r = (r?.[exc.rest.endpoints.trades.response.data_inside] || r);

      if (exc.rest.endpoints.trades.response.get_first_value)
        r = Object.values(r)[0];

      init_trades = r;
    })
  ];

  // Set promise to get initial orderbook snapshot. (If required)
  if (exc.rest.endpoints.orderbook)
    _proms.push(
      fetch(
        (exc.rest.url + exc.rest.endpoints.orderbook.path)
        .replace('<market>', market.rest)
      )
      .then(r => r.json())
      .then(r => {
        if (r?.[exc.rest.error.key] != undefined) {
          let really_an_error = false;
          
          if (exc.rest.error.is_array) {
            if (r[exc.rest.error.key].length > 0)
              really_an_error = true;
          } else {
            if (exc.rest.error.value == undefined || r[exc.rest.error.key] == exc.rest.error.value)
              really_an_error = true;
          }

          if (really_an_error) throw { endpoint: 'available_pairs', error: r };
        }

        r = (r?.[exc.rest.endpoints.trades.response.data_inside] || r);

        init_orderbook = r;
      })
    );

  // Tenta fazer as requisições definidas acima com um TIMEOUT.
  try {
    await Promise.race([
      new Promise((resolve, reject) => setTimeout(reject, (exc.rest.timeout || 5000), "TIMEOUT.")),
      Promise.all(_proms)
    ]);
  } catch (err) {
    console.log('[E] Initial snapshot request(s):',err);
    throw 'Initial snapshot request(s) failed.'
  }

  // console.log('init_trades:',init_trades);
  
  // Set trades from initial snapshot.
  trades = (exc.rest.endpoints.trades.response.newer_first ? init_trades.reverse() : init_trades)
  .map(t => {
    let obj = {
      timestamp: exc.timestamp_ISO_format ? new Date(t[exc.rest.endpoints.trades.response.timestamp]).getTime() : t[exc.rest.endpoints.trades.response.timestamp],
      is_buy: (t[exc.rest.endpoints.trades.response.is_buy_key] == exc.rest.endpoints.trades.response.is_buy_value),
      price: t[exc.rest.endpoints.trades.response.price],
      amount: t[exc.rest.endpoints.trades.response.amount]
    };

    if (exc.rest.endpoints.trades.response.trade_id_key != undefined)
      obj.trade_id = t[exc.rest.endpoints.trades.response.trade_id_key];

    if (exc.trades_custom_id)
      obj.custom_id = Object.values(t).filter(v => v != obj.trade_id).join('');

    const _pagination = exc.rest.endpoints.trades.response.pagination;
    if (_pagination?.page_id != undefined)
      obj['_'+_pagination.page_id] = t[_pagination.page_id];

    return obj;
  });

  // Do the trades pagination if needed.
  if (exc.rest.endpoints.trades.response.pagination != undefined) {
    const _pagination = exc.rest.endpoints.trades.response.pagination; 

    console.log('Trades pagination...');

    if (_pagination.check_for_newer) {
      console.log('_pagination.max_arr_size:',_pagination.max_arr_size);
      let trades_resp_arr_size = init_trades.length;
      while (trades_resp_arr_size == _pagination.max_arr_size) {
        console.log('trades_resp_arr_size:',trades_resp_arr_size);

        let raw_trades = null;
        try {
          raw_trades = await Promise.race([
            new Promise((resolve, reject) => setTimeout(reject, (exc.rest.timeout || 5000), "TIMEOUT.")),
            fetch(
              (exc.rest.url + exc.rest.endpoints.trades.path + _pagination.to_add_url)
              .replace(_pagination.to_del_url, '')
              .replace('<market>', market.rest)
              .replace('<since>', since)
              .replace('<page_id>', trades[trades.length-1]['_'+_pagination.page_id]) // Newer trade id.
            )
            .then(r => r.json())
            .then(r => {
              if (r?.[exc.rest.error.key] != undefined) {
                let really_an_error = false;
                
                if (exc.rest.error.is_array) {
                  if (r[exc.rest.error.key].length > 0)
                    really_an_error = true;
                } else {
                  if (exc.rest.error.value == undefined || r[exc.rest.error.key] == exc.rest.error.value)
                    really_an_error = true;
                }
        
                if (really_an_error) throw { endpoint: 'trades (at pagination)', error: r };
              }
                
              r = (r?.[exc.rest.endpoints.trades.response.data_inside] || r);
        
              if (exc.rest.endpoints.trades.response.get_first_value)
                r = Object.values(r)[0];
        
              return r;
            })
          ]);
        } catch (err) {
          console.log('[E] At trades pagination loop:',err);
          throw "Failed to get all necessary trades.";
        }

        let newer_trades = raw_trades.map(t => {
          let obj = {
            timestamp: exc.timestamp_ISO_format ? new Date(t[exc.rest.endpoints.trades.response.timestamp]).getTime() : t[exc.rest.endpoints.trades.response.timestamp],
            is_buy: (t[exc.rest.endpoints.trades.response.is_buy_key] == exc.rest.endpoints.trades.response.is_buy_value),
            price: t[exc.rest.endpoints.trades.response.price],
            amount: t[exc.rest.endpoints.trades.response.amount]
          };

          if (exc.rest.endpoints.trades.response.trade_id_key != undefined)
            obj.trade_id = t[exc.rest.endpoints.trades.response.trade_id_key];
      
          if (exc.trades_custom_id)
            obj.custom_id = Object.values(t).filter(v => v != obj.trade_id).join('');
      
          const _pagination = exc.rest.endpoints.trades.response.pagination;
          if (_pagination?.page_id != undefined)
            obj['_'+_pagination.page_id] = t[_pagination.page_id];
      
          return obj;
        })
        .filter(t => { // Evita trades repetidos.
          const _key = exc.rest.endpoints.trades.response.trade_id_key != undefined ? 'trade_id' : 'custom_id';
          return trades.every(rt => rt[_key] != t[_key]);
        });
        
        if (_pagination.newer_first) {
          trades = [ ...trades, ...newer_trades.reverse() ];
          trades_resp_arr_size = newer_trades.length;
        } else {
          trades = [ ...trades, ...newer_trades ];
          trades_resp_arr_size = newer_trades.length;
        }
      }

      console.log('[!] Got all necessary trades: trades_resp_arr_size=',trades_resp_arr_size);

    } else {
      console.log('since=',since);
      console.log('(since - 1e3)=',since - 1e3);
      let older_trade = trades[0];

      while (older_trade.timestamp > since - 1e3) {
        console.log('older_trade.timestamp=',older_trade.timestamp);
        
        let raw_trades = null;
        try {
          raw_trades = await Promise.race([
            new Promise((resolve, reject) => setTimeout(reject, (exc.rest.timeout || 5000), "TIMEOUT.")),
            fetch(
              (exc.rest.url + exc.rest.endpoints.trades.path + exc.rest.endpoints.trades.response.pagination.to_add_url)
              .replace('<market>', market.rest)
              .replace('<since>', since)
              .replace('<page_id>', older_trade['_'+_pagination.page_id])
            )
            .then(r => r.json())
            .then(r => {
              if (r?.[exc.rest.error.key] != undefined) {
                let really_an_error = false;
                
                if (exc.rest.error.is_array) {
                  if (r[exc.rest.error.key].length > 0)
                    really_an_error = true;
                } else {
                  if (exc.rest.error.value == undefined || r[exc.rest.error.key] == exc.rest.error.value)
                    really_an_error = true;
                }
        
                if (really_an_error) throw { endpoint: 'trades (at pagination)', error: r };
              }
                
              r = (r?.[exc.rest.endpoints.trades.response.data_inside] || r);
        
              if (exc.rest.endpoints.trades.response.get_first_value)
                r = Object.values(r)[0];
        
              return r;
            })
          ]);
        } catch (err) {
          console.log('[E] At trades pagination loop:',err);
          throw "Failed to get all necessary trades.";
        }

        let older_trades = raw_trades.map(t => {
          let obj = {
            timestamp: exc.timestamp_ISO_format ? new Date(t[exc.rest.endpoints.trades.response.timestamp]).getTime() : t[exc.rest.endpoints.trades.response.timestamp],
            is_buy: (t[exc.rest.endpoints.trades.response.is_buy_key] == exc.rest.endpoints.trades.response.is_buy_value),
            price: t[exc.rest.endpoints.trades.response.price],
            amount: t[exc.rest.endpoints.trades.response.amount]
          };

          if (exc.rest.endpoints.trades.response.trade_id_key != undefined)
            obj.trade_id = t[exc.rest.endpoints.trades.response.trade_id_key];
      
          if (exc.trades_custom_id)
            obj.custom_id = Object.values(t).filter(v => v != obj.trade_id).join('');
      
          const _pagination = exc.rest.endpoints.trades.response.pagination;
          if (_pagination?.page_id != undefined)
            obj['_'+_pagination.page_id] = t[_pagination.page_id];
      
          return obj;
        })
        .filter(t => { // Evita trades repetidos.
          const _key = exc.rest.endpoints.trades.response.trade_id_key != undefined ? 'trade_id' : 'custom_id';
          return trades.every(rt => rt[_key] != t[_key]);
        });

        if (_pagination.newer_first) {
          trades = [ ...older_trades.reverse(), ...trades ]; // Newer at last.
          older_trade = trades[0];
        } else {
          trades = [ ...older_trades, ...trades ]; // Newer at last.
          older_trade = trades[0];
        }
      }

      console.log('[!] Got all necessary trades: since=',since,'older_trade.timestmap=',older_trade.timestamp);
    }
  }

  // Evita trades repetidos.
  trades_upd_cache = trades_upd_cache.filter(t => { 
    if (exc.ws.subcriptions.trades.update.id_should_be_higher)
      return t.trade_id > trades[trades.length-1].trade_id;

    const _key = exc.ws.subcriptions.trades.update.trade_id_key != undefined ? 'trade_id' : 'custom_id';
    return trades.every(rt => rt[_key] != t[_key]);
  });

  console.log('cached trades:',trades_upd_cache);
  console.log('trades from init_trades:',trades);

  // Apply cached trades updates.
  if (trades_upd_cache.length > 0) {
    trades = [ // Newer at the end here. 
      ...(exc.rest.endpoints.trades.response.newer_first ? trades.reverse() : trades), 
      ...trades_upd_cache
    ];
    trades_upd_cache = [];
  }
  
  // If got initial orderbook, set initial orderbook.
  if (init_orderbook) {
    orderbook = {
      asks: Object.fromEntries(init_orderbook[exc.rest.endpoints.orderbook.response.asks]),
      bids: Object.fromEntries(init_orderbook[exc.rest.endpoints.orderbook.response.bids]),
      timestamp: init_orderbook?.[exc.rest.endpoints.orderbook.response.timestamp],
      last_update_nonce: init_orderbook?.[exc.rest.endpoints.orderbook.response.last_update_nonce]
    };

    // Apply cached orderbook updates.
    while (orderbook_upd_cache.length > 0) {
      apply_orderbook_upd(orderbook_upd_cache[0]);
      orderbook_upd_cache.shift();
    }
  }
}

// export default syncronizer;

// Debugging 'syncronizer'.
let _orderbook = null; // Will sotre a simplified version of orderbook.
syncronizer()
.then(() => {
  // console.log('orderbook:',orderbook);
  // console.log('trades:',trades);

  const everySecond = () => {
    // Set time variables.
    const timestamp = Date.now();
    const second = Math.floor(timestamp / 1e3);
    const data_time = second - 1;

    // Call 'everySecond' again at each new second.
    setTimeout(everySecond, (second + 1) * 1e3 - timestamp);
  
    // Trades that ocurred in the last second.
    const _trades = trades.filter(t => 
      t.timestamp >= (data_time - 1) * 1e3 &&
      t.timestamp < data_time * 1e3
    );
  
    // Log everything. (Just for debuging...)
    if (_orderbook != null) 
      console.log({
        asks: _orderbook.asks.slice(0, 5),
        bids: _orderbook.bids.slice(0, 5),
        book_timestamp: _orderbook.timestamp,
        trades: _trades,
        second: data_time,
        timestamp
      });
  
    // A simpliflied version of orderbook, w/ 25 depth.
    _orderbook = {
      asks: Object.entries(orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 25),
      bids: Object.entries(orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 25),
      timestamp: orderbook.timestamp
    };
  
    // Remove anything older then 3 seconds from 'trades'.
    trades = trades.filter(t => t.timestamp > (second - 3) * 1e3);
  };
  setTimeout(everySecond, 1e3 - Date.now() % 1e3);
})
.catch(err => {
  console.log(err,'\nExiting...');
  process.exit(1);
});