import WebSocket from 'ws';
import Big from 'big.js';
import fetch from 'node-fetch';
import crypto from 'crypto';
import exchanges from './Exchanges/index.js';
import dotenv from 'dotenv';
dotenv.config();

// Commonjs importing 
import pkg from 'node-gzip';
import { resolve } from 'path';
import { rejects } from 'assert';
const { ungzip } = pkg;

let args = process.argv.slice(2); // Get command-line arguments, starting from index 2

// Set the default 'delay_time_in_seconds' to 3.
if (args.length === 3) args.push(3);

if (args.length !== 4) {
  console.log("Usage: npm sync <exchange> <base> <quote> <delay_time_in_seconds>(optional, default= 3)");
  process.exit(1);
}

// Melhorias para fazer:
// [*] Remove 'custom_id' and 'trade_id' from trades array when posting every second.
// [*] Fix the delayed version of 'orderbook'.
// [*] Let the user set how much delayed post data should be. (Set default to 3 seconds)
// [*] Better orderbook sync mechanism and better validation of orderbooks update.
// [ ] Re-sync mechanism (for both orderbook and trades) in case of a disconnect from the server.
// [ ] Sempre que possível se inscrever no canal 'book_snap' além de 'book_diff' ???
// [ ] Set the default delay to 1 second, so if we disconnect we can reconnect we get trades snapshot in the last second and don't lose any second to post.

// Exchanges to add:
// (USD)
// [*] kraken-spot
// [*] coinbase-spot
// [*] gemini-spot
// [*] bitstamp-spot
// [*] bitfinex-spot
// [ ] cryptodotcom-spot

// (USDT)
// [*] binance-spot
// [*] okx-spot
// [*] htx-spot (huobi)
// [*] mexc-spot
// [*] bybit-spot
// [ ] kucoin-spot

let exchange = args[0];
let base = args[1];
let quote = args[2];
const delay_time_in_seconds = args[3];

let markets = null;
let info = { }; // Will store orderbook and trades websocket information.

let orderbook = null;
let orderbook_upd_cache = [];

let orderbooks = [];
let delayed_orderbook = null; // Will store the delayed and simplified version of orderbook.

let trades = null;
let trades_upd_cache = [];

let exc = null;
let api = {};
let market = {};
let ws_req_nonce = 0;
let authenticate = null;


function apply_orderbook_upd (upd, ws, just_ignore_lower_nonce_upd = (info.orderbook_snap?.is_subscribed === true)) {
  // console.log('Book upd:',upd);

  // Validate updates.
  if (upd.last_update_nonce && upd.last_update_nonce <= orderbook.last_update_nonce) {
    if (!just_ignore_lower_nonce_upd) {
      console.log('[E] apply_orderbook_upd: upd.last_update_nonce ('+upd.last_update_nonce+') <= orderbook.last_update_nonce ('+orderbook.last_update_nonce+').');
      ws.terminate();
    }
    return;
  }

  if (upd.first_update_nonce) {
    if (orderbook.received_first_update) {
      if (upd.first_update_nonce != orderbook.last_update_nonce + 1) {
        console.log('[E] apply_orderbook_upd: upd.first_update_nonce ('+upd.first_update_nonce+') <= != orderbook.last_update_nonce + 1 ('+(orderbook.last_update_nonce + 1)+').');
        ws.terminate();
        return;
      }
    } else {
      if (upd.first_update_nonce > orderbook.last_update_nonce + 1) {
        console.log('[E] apply_orderbook_upd: upd.first_update_nonce ('+upd.first_update_nonce+') > orderbook.last_update_nonce + 1 ('+(orderbook.last_update_nonce + 1)+').');
        ws.terminate();
        return;
      }
    }
  }
  
  if (delayed_orderbook === null || Math.floor(orderbook.timestamp / 1e3) != Math.floor(upd.timestamp / 1e3)) {
    let save_it = (delayed_orderbook != null);
    delayed_orderbook = {
      asks: Object.entries(orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 25),
      bids: Object.entries(orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 25),
      timestamp: orderbook.timestamp
    };
    if (save_it) orderbooks.unshift(delayed_orderbook);
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

function handle_orderbook_msg (msg, _prom, _ws, ws) {
  // console.log('Book update:',msg);

  if (msg.is_snapshot) {
    if (orderbook == null || (
      orderbook.last_update_nonce == undefined ||
      msg.last_update_nonce == undefined || 
      Big(msg.last_update_nonce).gt(orderbook.last_update_nonce)
    )) {
      // Updates 'delayed_orderbook' if it the case.
      if (orderbook != null && (
        delayed_orderbook === null || 
        Math.floor(orderbook.timestamp / 1e3) != Math.floor(msg.timestamp / 1e3)
      )) {
        let save_it = (delayed_orderbook != null);
        delayed_orderbook = {
          asks: Object.entries(orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 25),
          bids: Object.entries(orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 25),
          timestamp: orderbook.timestamp
        };
        if (save_it) orderbooks.unshift(delayed_orderbook);
      }

      orderbook = {
        asks: Object.fromEntries(msg.asks),
        bids: Object.fromEntries(msg.bids),
        timestamp: msg.timestamp,
        last_update_nonce: msg.last_update_nonce
      };

      // Apply cached orderbook updates.
      while (orderbook_upd_cache.length > 0) {
        apply_orderbook_upd(orderbook_upd_cache[0], ws, true);
        orderbook_upd_cache.shift();
      }

      if ((!info.orderbook.is_subscribed) && exc.rest.endpoints.orderbook == undefined) {
        info.orderbook.is_subscribed = true;

        // Se também já estiver incrito a 'trades' resolve a promessa.
        if (_ws.not_handle_trades === true || (info.trades?.is_subscribed && _prom)) 
          _prom.resolve();
      }
    }
  } else {
    if (orderbook == null) {
      // Just cache update.
      orderbook_upd_cache.push(msg);

    } else if (orderbook_upd_cache.length > 0) {
      // Apply all cached orderbook updates.
      while (orderbook_upd_cache.length > 0) {
        apply_orderbook_upd(orderbook_upd_cache[0], ws, true);
        orderbook_upd_cache.shift();
      }

      // Then apply update.
      apply_orderbook_upd(msg, ws);

    } else {
      // Just apply update.
      apply_orderbook_upd(msg, ws);
    }
  }
}

function handle_trades_msg (msg, _ws) {
  // console.log('Trades update:',msg);
  
  if (msg == null) return; // Ignore.
  const _t_upd = _ws.subcriptions.trades.update;

  if (trades == null || trades_upd_cache.length > 0) {
    // Avoid chaching trades already cached.
    if (_t_upd.id_should_be_higher === true && 
    _t_upd.trade_id_key != undefined) {
      msg = msg.filter(trade => trades_upd_cache.every(t => t.trade_id != trade.trade_id));
      if (msg.length < 1) return;
    }

    trades_upd_cache = [ ...trades_upd_cache, ...msg ];

  } else {
    // Avoid adding trades already added.
    if (_t_upd.id_should_be_higher === true && 
    _t_upd.trade_id_key != undefined) {
      msg = msg.filter(trade => trades.every(t => t.trade_id != trade.trade_id));
      if (msg.length < 1) return;
    }

    trades = [ ...trades, ...msg ];
  }
}

function format_orderbook_msg (msg, _ws, is_orderbook_snap = false) {
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
  // if (is_orderbook_snap) console.log('Book snap msg:',msg);

  const _orderbook = is_orderbook_snap ? _ws.subcriptions.orderbook_snap : _ws.subcriptions.orderbook;

  // Define if this orderbook message is an updade or a snapshot.
  let is_snapshot = is_orderbook_snap;

  // 'its_first_update'
  if (info.orderbook._received_first_update !== true && 
  _orderbook.snapshot?.its_first_update === true) {
    info.orderbook._received_first_update = true;
    is_snapshot = true;
  }

  if (!is_orderbook_snap) {
    let identifier_key_value = null;
    if (_orderbook.snapshot?.identifier_key)
      identifier_key_value = _orderbook.snapshot.identifier_key.split('.').reduce((f, k) => f = f?.[k], msg);
  
    if (identifier_key_value != undefined) {
      is_snapshot = (
        _orderbook.snapshot?.identifier_value == undefined || 
        identifier_key_value == _orderbook.snapshot.identifier_value
      );
    }
  }

  // Construct the formatted message.
  let updates = (msg[_orderbook.update.updates_inside] || msg);
  let asks = [];
  let bids = [];

  if (
    (is_snapshot && _orderbook.snapshot?.asks_and_bids_together) || 
    ((!is_snapshot) && _orderbook.update.asks_and_bids_together)
  ) {
    updates.forEach(x => {
      const _pl =  is_snapshot ? (_orderbook.snapshot?.pl || _orderbook.update.pl) : _orderbook.update.pl;

      let price = x[ _pl.price ];
      let amount = x[ _pl.amount ];
      let is_bids = undefined;

      if (_orderbook.update.is_bids_positive_amount) {
        is_bids = Big(x[_pl.amount]).gt(0);
        amount = Big(amount).abs().toFixed();
      } else {
        is_bids = (x[_pl.is_bids_key] == _pl.is_bids_value);
      }

      if (_pl.to_remove_key != undefined && 
      x[_pl.to_remove_key] != undefined && 
      (_pl.to_remove_value == undefined || 
      x[_pl.to_remove_key] == _pl.to_remove_value))
        amount = 0;
      
      if (is_bids)
        bids.push([ price, amount ]);
      else
        asks.push([ price, amount ]);
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
    else if (exc.timestamp_in_micro || _orderbook.update.timestamp_in_micro)
      formatted.timestamp /= 1e3;

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
    else if (exc.timestamp_in_micro || _orderbook.update.timestamp_in_micro)
      formatted.timestamp /= 1e3;
  }

  // Set first and last update_nonces if required.
  if (_orderbook.update.first_upd_nonce_key)
    formatted.first_update_nonce = (msg[_orderbook.update.first_upd_nonce_key] || updates[_orderbook.update.first_upd_nonce_key]);
  else if (_orderbook.update.prev_upd_nonce_key)
    formatted.first_update_nonce = (msg[_orderbook.update.prev_upd_nonce_key] || updates[_orderbook.update.prev_upd_nonce_key]) * 1 + 1;
  
  if (_orderbook.update.last_upd_nonce_key)
    formatted.last_update_nonce = (msg[_orderbook.update.last_upd_nonce_key] || updates[_orderbook.update.last_upd_nonce_key]);

  // Retorna a mensagem formatada.
  // console.log('Formatted book msg:',formatted);
  // if (is_orderbook_snap) console.log('Formatted book snap msg:',formatted);
  return formatted;
}

function format_trades_msg (msg, _ws) {
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

  const _t_upd = _ws.subcriptions.trades.update;

  if (_t_upd.ignore_first_update === true) {
    if (info.trades.received_first_update !== true) {
      info.trades.received_first_update = true;
      return null;
    }
  }
  
  // Se recebe cada trade como um objeto unico, insere esse trade dentro de um array.
  if (_ws.subcriptions.trades.update.receive_separately_trades_as_obj) 
    msg = [ msg ];

  // Retorna trades formatados.
  return (msg?.[_ws.subcriptions.trades.update.trades_inside] || msg).map(t => {
    let timestamp = (t[_ws.subcriptions.trades.update.timestamp] || msg[_ws.subcriptions.trades.update.timestamp]);
  
    if (exc.timestamp_in_seconds || _ws.subcriptions.trades.update.timestamp_in_seconds)
      timestamp *= 1e3;
    else if (exc.timestamp_ISO_format || _ws.subcriptions.trades.update.timestamp_ISO_format)
      timestamp = new Date(timestamp).getTime();
    else if (exc.timestamp_in_micro || _ws.subcriptions.trades.update.timestamp_in_micro)
      timestamp /= 1e3;
    
    let obj = {
      timestamp,
      is_buy: undefined,
      price: t[_t_upd.price],
      amount: t[_t_upd.amount]
    };

    if (_t_upd.is_buy_key != undefined) {
      obj.is_buy = (t[_t_upd.is_buy_key] == _t_upd.is_buy_value);

    } else if (_t_upd.is_buy_positive_amount === true) {
      obj.is_buy = Big(obj.amount).gt(0);
      obj.amount = Big(obj.amount).abs().toFixed();

    } else {
      throw "[E] Parsing trades update: Can not determine trade side."
    }

    if (_ws.subcriptions.trades.update.trade_id_key != undefined)
      obj.trade_id = t[_ws.subcriptions.trades.update.trade_id_key];

    if (exc.trades_custom_id)
      obj.custom_id = '' + obj.timestamp + obj.is_buy + obj.price + obj.amount;
      // obj.custom_id = Object.values(t).filter(v => v != obj.trade_id).join('');

    return obj;
  });
}

function make_subscriptions (info, ws, _ws) {
  // Envia 'to_send_before_subcriptions'.
  if (_ws.to_send_before_subcriptions != undefined) {
    for (const data of _ws.to_send_before_subcriptions)
      ws.send(data);
  }

  // Envia pedido de subscrição de trades.
  if (_ws.not_handle_trades !== true) {
    let trades_sub_req = null;
    if (_ws.subcriptions.trades?.request != undefined) {
      trades_sub_req = _ws.subcriptions.trades.request
      .replaceAll('<market>', market.ws)
      .replace('<ws_req_id>', ++ws_req_nonce);

      info.trades.req_id = _ws.subcriptions.trades.response.id_value || ws_req_nonce;
      if (isNaN(info.trades.req_id))
        info.trades.req_id = info.trades.req_id.replaceAll('<market>', market.ws);
  
      // console.log('Sending trades subscription request:\n',trades_sub_req);
      ws.send(trades_sub_req);

      // Se não temos um 'trades.response', devemos asumir que 'info.trades.is_subscribed' é true apartir daqui.
      if (!_ws.subcriptions.trades.response) {
        info.trades.is_subscribed = true;
        console.log('[!] Successfully subscribed to trades updates.');
        // Se também já estiver incrito a 'orderbook' resolve a promessa.
        if (_ws.not_handle_orderbook === true || (info.orderbook?.is_subscribed && _prom)) 
          _prom.resolve();
      }
    }
  }
  
  // Envia pedido de subscriçao de orderbook.
  if (_ws.not_handle_orderbook !== true) {
    let orderbook_sub_req = null;
    if (_ws.subcriptions.orderbook?.request != undefined) {
      orderbook_sub_req = _ws.subcriptions.orderbook.request
      .replaceAll('<market>', market.ws)
      .replace('<ws_req_id>', ++ws_req_nonce);

      info.orderbook.req_id = _ws.subcriptions.orderbook.response?.id_value || ws_req_nonce;
      if (isNaN(info.orderbook.req_id))
        info.orderbook.req_id = info.orderbook.req_id.replaceAll('<market>', market.ws);
    
      // Autentica requisição de subscrição do orderbook se necessario.
      if (_ws.subcriptions.orderbook.require_auth) {
        const { signature, sign_nonce } = authenticate();
        
        orderbook_sub_req = orderbook_sub_req
        .replace('<api_key>', api.key)
        .replace('<api_pass>', api.pass)
        .replace('<sign_nonce>', sign_nonce)
        .replace('<signature>', signature);
      }
      
      // console.log('Sending orderbook subscription request:\n',orderbook_sub_req);
      ws.send(orderbook_sub_req);
      
      // Se não temos um 'orderbook.response', devemos asumir que 'info.orderbook.is_upds_subscribed' é true apartir daqui.
      if (!_ws.subcriptions.orderbook.response) {
        info.orderbook.is_upds_subscribed = true;
        if (exc.rest.endpoints.orderbook != undefined) {
          info.orderbook.is_subscribed = true;
          // Se também já estiver incrito a 'trades' resolve a promessa.
          if (_ws.not_handle_trades === true || (info.trades?.is_subscribed && _prom))
            _prom.resolve();
        }
        console.log('[!] Successfully subscribed to orderbook updates.');
      }
    }

    // Envia pedido de subscriçao de orderbook snapshot.
    let orderbook_snap_sub_req = null;
    if (_ws.subcriptions.orderbook_snap?.request != undefined) {
      orderbook_snap_sub_req = _ws.subcriptions.orderbook_snap.request
      .replaceAll('<market>', market.ws)
      .replace('<ws_req_id>', ++ws_req_nonce);
  
      info.orderbook_snap.req_id = _ws.subcriptions.orderbook_snap.response.id_value || ws_req_nonce;
      
      // console.log('Sending orderbook snapshot subscription request:\n',orderbook_snap_sub_req);
      ws.send(orderbook_snap_sub_req);

      // Se não temos um 'orderbook_snap.response', devemos asumir que 'info.orderbook_snap.is_subscribed' é true apartir daqui.
      if (_ws.subcriptions.orderbook_snap?.response == undefined) {
        info.orderbook_snap.is_subscribed = true;
        console.log('[!] Successfully subscribed to orderbook snapshot updates.');
      }
    }
  }
}

function handle_trades_sub_resp (msg, _ws, market, info, _prom) {
  info.trades.is_subscribed = true;
    
  if (_ws.subcriptions.trades?.response?.channel_id_key && 
  (_ws.subcriptions.trades.response.channel_id_val == undefined ||
  msg[_ws.subcriptions.trades.response.channel_id_key] == _ws.subcriptions.trades.response.channel_id_val.replaceAll('<market>', market.ws)))
    info.trades.channel_id = msg[_ws.subcriptions.trades.response.channel_id_key];
  else if (_ws.subcriptions.trades.update.channel_id)
    info.trades.channel_id = _ws.subcriptions.trades.update.channel_id.replaceAll('<market>', market.ws);
  else
    throw "Neither 'trades.response.channel_id_key' or 'trades.update.channel_id' are defined.";

  console.log('[!] Successfully subscribed to trades updates.');

  // Se também já estiver inscrito a 'orderbook' resolve a promessa.
  if (_ws.not_handle_orderbook === true || (info.orderbook?.is_subscribed && _prom)) 
    _prom.resolve();
}

function connect (_ws) {
  console.log('Connecting to '+exchange+' '+market.ws+'...');

  // Reseta as variaveis.
  if (_ws.not_handle_orderbook !== true) {
    orderbook = null;
    orderbook_upd_cache = [];
  }
  if (_ws.not_handle_trades !== true) {
    trades = null;
    trades_upd_cache = [];
  }

  // Cria objeto para armazenar informações a respeito de 'orderbook' e 'trades'.
  if (_ws.not_handle_trades !== true) info.trades = {};
  if (_ws.not_handle_orderbook !== true) {
    info.orderbook = {};
    if (_ws.subcriptions.orderbook_snap) info.orderbook_snap = {};
  }

  // Se não temos um 'orderbook.response', 'info.orderbook.channel_id' deve ser definido aqui.
  if (_ws.not_handle_orderbook !== true && _ws.subcriptions.orderbook != undefined && _ws.subcriptions.orderbook.response == undefined) 
    info.orderbook.channel_id = _ws.subcriptions.orderbook.update.channel_id
      .replaceAll('<market>', market.ws);

  // Se não temos um 'trades.response', 'info.trades.channel_id' deve ser definido aqui.
  if (_ws.not_handle_trades !== true && _ws.subcriptions.trades?.response == undefined) 
    info.trades.channel_id = _ws.subcriptions.trades?.update?.channel_id
      .replaceAll('<market>', market.ws);

  // Cria uma variaveis de controle para 'ping loop'.
  let ping_loop_interval;
  let keep_alive = true;

  // Cria uma variaveis de controle para 'ws ping loop'.
  let ws_ping_loop_interval;
  let ws_keep_alive = true;

  // Cria uma promessa 'prom' e uma variavél '_prom' para futuramente resolver ou rejeitar a promessa.
  let _prom = null;
  let prom = new Promise((resolve, reject) => _prom = { resolve, reject })
  .finally(() => _prom = null); // Ao finalizar a promesa '_prom' volta ser NULL.

  // Cria um timeout para rejeitar a promessa caso a mesma não resolva logo.
  setTimeout(_prom.reject, (_ws.timeout || 5000), "TIMEOUT.");

  // Cria uma conexão com o websocket da exchange.
  const ws = new WebSocket(
    _ws.url
    .replaceAll('<market>', market.ws)
  );

  // Quando recebermos um ping, enviaremos um pong.
  ws.on('ping', ws.pong);

  // Quando recebermos um pong, manteremos a conexão aberta.
  ws.on('pong', () => keep_alive = true);

  // Quando perdemos a conexão iremos tentar nos conectar novamente.
  ws.on('close', () => {
    // Reseta as variaveis.
    if (_ws.not_handle_orderbook !== true) {
      orderbook = null;
      orderbook_upd_cache = [];
      info.orderbook = {};
      if (_ws.subcriptions.orderbook_snap) info.orderbook_snap = {};
    }
    if (_ws.not_handle_trades !== true) {
      trades = null;
      trades_upd_cache = [];
      info.trades = {};
    }

    clearInterval(ping_loop_interval);
    clearInterval(ws_ping_loop_interval);
    connect(_ws);
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
        console.log('[E] ping_loop: O servior não responseu ao nosso ping em até '+((_ws.timeout || 5000) / 1e3)+' segundos, encerrando conexão...');
        ws.terminate();
      }
      keep_alive = false;
      ws.ping();

      if (_ws.ping?.request != undefined && _ws.ping.response == undefined) // Just ping and do not wait for response.
        ws.send(_ws.ping.request);

    }, (_ws.timeout || 5000));

    // Inicia 'ws ping loop', se definido corretamente.
    if (_ws.ping?.request != undefined && _ws.ping.response != undefined) {
      ws_ping_loop_interval = setInterval(() => {
        if (!ws_keep_alive) {
          console.log('[E] ws_ping_loop: O servior não responseu ao nosso ping em até '+((_ws.ping.interval || _ws.timeout || 5000) / 1e3)+' segundos, encerrando conexão...');
          ws.terminate();
        }
        ws_keep_alive = false;
        ws.send(_ws.ping.request);

      }, (_ws.ping.interval || _ws.timeout || 5000));
    }

    if (_ws.login != undefined) {
      // Sends login request.
      const { signature, sign_nonce } = authenticate();
      ws.send(
        _ws.login.request
        .replace('<api_key>', api.key)
        .replace('<api_pass>', api.pass)
        .replace('<sign_nonce>', sign_nonce)
        .replace('<signature>', signature)
      );

    } else {
      make_subscriptions(info, ws, _ws);
    }
  });

  // Finalmente, aqui processaremos os dados recebidos do servidor.
  ws.on('message', async msg => {
    // Decript message if needed
    if (_ws.gzip_encrypted) msg = await ungzip(msg);

    // Try to parse mesage as a JSON.
    try { msg = JSON.parse(msg); } catch (e) { msg = msg.toString(); }

    // console.log('WebSocket message:',msg);

    // Checks if msg is an error.
    if (msg?.[_ws.error.key] != undefined && 
    (_ws.error.value == undefined || msg[_ws.error.key] == _ws.error.value) &&
    (_ws.error.value_not == undefined || msg[_ws.error.key] != _ws.error.value_not)) {
      console.log('[E] ('+exchange+' '+market.ws+') WebSocket API Error:',msg);
      ws.terminate();
      return;
    }

    // If 'login', check if its a login response.
    if (_ws.login != undefined && 
    msg[_ws.login.response.id_key] != undefined && 
    (_ws.login.response.id_value == null || msg[_ws.login.response.id_key] == _ws.login.response.id_value)) {
      if (_ws.login.response.success_key == undefined || (
        msg[_ws.login.response.success_key] != undefined && (
          _ws.login.response.success_value == undefined || 
          msg[_ws.login.response.success_key] == _ws.login.response.success_value
        )
      )) {
        console.log('[!] Logado com sucesso.');
        make_subscriptions(info, ws, _ws);

      } else {
        console.log('[E] Falha ao fazer login:',msg);
        if (_prom) 
          _prom.reject({ endpoint: "ws-login", error: msg });
        else 
          ws.terminate();
      }

      return;
    }

    // Hanlde 'ws ping' response.
    if (_ws.ping?.response != undefined) {
      let _id_value = _ws.ping.response.id.split('.').reduce((f, k) => f = f?.[k], msg);
      if (_id_value != undefined && 
      (_ws.ping.response.id_value == undefined || _id_value == _ws.ping.response.id_value)) {
        ws_keep_alive = true;
        return;
      }
    }

    // Handle 'trades' subscription response.
    if (_ws.not_handle_trades !== true && (!info.trades.is_subscribed) && _ws.subcriptions.trades?.request != undefined) {
      let this_is_trades_subscription_response = false;

      if (_ws.subcriptions.trades.response.is_object) {
        if (msg[_ws.subcriptions.trades.response.object_id_key] == _ws.subcriptions.trades.response.object_id_value &&
        _ws.subcriptions.trades.response.id.split('.').reduce((f, k) => f = f?.[k], msg) == info.trades.req_id)
          this_is_trades_subscription_response = true;

      } else if (_ws.subcriptions.trades.response.acum_list) {
        if (msg[_ws.subcriptions.trades.response.list_id_key] == _ws.subcriptions.trades.response.list_id_value &&
        (msg[_ws.subcriptions.trades.response.list_inside] || msg).some(
          x => x[_ws.subcriptions.trades.response.id] == _ws.subcriptions.trades.response.id_value
        ))
          this_is_trades_subscription_response = true;

      } else if (_ws.subcriptions.trades.response.id.split('.').reduce((f, k) => f = f?.[k], msg) == info.trades.req_id) {
        this_is_trades_subscription_response = true;
      }

      if (this_is_trades_subscription_response) 
        return handle_trades_sub_resp(msg, _ws, market, info, _prom);
    }

    // Handle 'orderbook' subscription response.
    if (_ws.not_handle_orderbook !== true && (!info.orderbook.is_upds_subscribed) && _ws.subcriptions.orderbook?.request != undefined) {
      let this_is_orderbook_subscription_response = false;
      let resp_id_value = _ws.subcriptions.orderbook.response.id.split('.').reduce((f, k) => f = f?.[k], msg);

      if (_ws.subcriptions.orderbook.response.is_object) {
        if (msg[_ws.subcriptions.orderbook.response.object_id_key] == _ws.subcriptions.orderbook.response.object_id_value &&
        resp_id_value != undefined && (_ws.subcriptions.orderbook.response.id_value === null || resp_id_value == info.orderbook.req_id))
          this_is_orderbook_subscription_response = true;

      } else if (_ws.subcriptions.orderbook.response.acum_list) {
        if (msg[_ws.subcriptions.orderbook.response.list_id_key] == _ws.subcriptions.orderbook.response.list_id_value &&
        (msg[_ws.subcriptions.orderbook.response.list_inside] || msg).some(
          x => x[_ws.subcriptions.orderbook.response.id] == _ws.subcriptions.orderbook.response.id_value
        ))
          this_is_orderbook_subscription_response = true;
      
      } else if (resp_id_value != undefined && 
      (_ws.subcriptions.orderbook.response.id_value === null || resp_id_value == info.orderbook.req_id)) {
        this_is_orderbook_subscription_response = true;
      }

      if (this_is_orderbook_subscription_response) {
        // Confere se resposta também inclui a incrição de 'trades'.
        if (_ws.not_handle_trades !== true && _ws.subcriptions.orderbook.response.include_trades)
          handle_trades_sub_resp(msg, _ws, market, info, _prom);

        if (_ws.subcriptions.orderbook.response.channel_id_key &&
        (_ws.subcriptions.orderbook.response.channel_id_val == undefined ||
        msg[_ws.subcriptions.orderbook.response.channel_id_key] == _ws.subcriptions.orderbook.response.channel_id_val.replaceAll('<market>', market.ws)))
          info.orderbook.channel_id = msg[_ws.subcriptions.orderbook.response.channel_id_key];
        else if (_ws.subcriptions.orderbook.update.channel_id)
          info.orderbook.channel_id = _ws.subcriptions.orderbook.update.channel_id.replaceAll('<market>', market.ws);
        else
          throw "Neither 'orderbook.response.channel_id_key' or 'orderbook.update.channel_id' are defined.";

        info.orderbook.is_upds_subscribed = true;
        console.log('[!] Successfully subscribed to orderbook updates.');
        if (exc.rest.endpoints.orderbook != undefined) {
          info.orderbook.is_subscribed = true;
          // Se também já estiver incrito a 'trades' resolve a promessa.
          if (_ws.not_handle_trades === true || (info.trades?.is_subscribed && _prom)) 
            _prom.resolve();
        }

        if (!_ws.subcriptions.orderbook.response.include_snapshot) return; // Otherwise, this message got be handled as an 'orderbook message'.
      }
    }

    // Handle 'orderbook_snap' subscription response.
    if (_ws.not_handle_orderbook !== true && (!info.orderbook_snap?.is_subscribed) && _ws.subcriptions.orderbook_snap?.request != undefined) {
      let this_is_orderbook_snap_subscription_response = false;
      let resp_id_value = _ws.subcriptions.orderbook_snap.response.id.split('.').reduce((f, k) => f = f?.[k], msg);

      if (_ws.subcriptions.orderbook_snap.response.is_object) {
        if (msg[_ws.subcriptions.orderbook_snap.response.object_id_key] == _ws.subcriptions.orderbook_snap.response.object_id_value &&
        resp_id_value != undefined && (_ws.subcriptions.orderbook_snap.response.id_value === null || resp_id_value == info.orderbook_snap.req_id))
          this_is_orderbook_snap_subscription_response = true;

      } else if (_ws.subcriptions.orderbook_snap.response.acum_list) {
        if (msg[_ws.subcriptions.orderbook_snap.response.list_id_key] == _ws.subcriptions.orderbook_snap.response.list_id_value &&
        (msg[_ws.subcriptions.orderbook_snap.response.list_inside] || msg).some(
          x => x[_ws.subcriptions.orderbook_snap.response.id] == _ws.subcriptions.orderbook_snap.response.id_value
        ))
        this_is_orderbook_snap_subscription_response = true;
      
      } else if (resp_id_value != undefined && 
      (_ws.subcriptions.orderbook_snap.response.id_value === null || resp_id_value == info.orderbook_snap.req_id)) {
        this_is_orderbook_snap_subscription_response = true;
      }

      if (this_is_orderbook_snap_subscription_response) {
        // Confere se resposta também inclui a incrição de 'trades'.
        if (_ws.not_handle_trades !== true && _ws.subcriptions.orderbook_snap.response.include_trades)
          handle_trades_sub_resp(msg, _ws, market, info, _prom);

        if (_ws.subcriptions.orderbook_snap.response.channel_id_key &&
        (_ws.subcriptions.orderbook_snap.response.channel_id_val == undefined ||
        msg[_ws.subcriptions.orderbook_snap.response.channel_id_key] == _ws.subcriptions.orderbook_snap.response.channel_id_val.replaceAll('<market>', market.ws)))
          info.orderbook_snap.channel_id = msg[_ws.subcriptions.orderbook_snap.response.channel_id_key];
        else if (_ws.subcriptions.orderbook_snap.update.channel_id)
          info.orderbook_snap.channel_id = _ws.subcriptions.orderbook_snap.update.channel_id.replaceAll('<market>', market.ws);
        else
          throw "Neither 'orderbook_snap.response.channel_id_key' or 'orderbook_snap.update.channel_id' are defined.";

        info.orderbook_snap.is_subscribed = true;
        console.log('[!] Successfully subscribed to orderbook snapshots updates.');

        if (!_ws.subcriptions.orderbook_snap.response.include_snapshot) return; // Otherwise, this message got be handled as an 'orderbook message'.
      }
    }

    // Handle 'orderbook' message.
    if (_ws.not_handle_orderbook !== true && _ws.subcriptions.orderbook != undefined) {
      let _channel_id = null;
      if ((!isNaN(_ws.subcriptions.orderbook.update.channel_id_key)) && _ws.subcriptions.orderbook.update.channel_id_key != "") {
        if (Big(_ws.subcriptions.orderbook.update.channel_id_key).abs().gt(msg.length || -1))
          _channel_id = undefined
        else
          _channel_id = msg.slice(_ws.subcriptions.orderbook.update.channel_id_key)[0]
      } else {
        _channel_id = _ws.subcriptions.orderbook.update.channel_id_key.split('.').reduce((f, k) => f = f?.[k], msg);
      }
      if ((info.orderbook.channel_id || _ws.subcriptions.orderbook.update.channel_id) && (
        _channel_id == info.orderbook.channel_id || 
        (_ws.subcriptions.orderbook.update.channel_id != undefined && // In some cases the orderbook subscription response will carry the snapshot in it, and we need to be able to parse an update (send it to 'orderbook_upd_cache') before receiving the orderbook subscription response.
        _channel_id == _ws.subcriptions.orderbook.update.channel_id.replaceAll('<market>', market.ws)) || 
        (_ws.subcriptions.orderbook?.snapshot?.channel_id != undefined &&
        _channel_id == _ws.subcriptions.orderbook.snapshot.channel_id)
      )) {
        if (_ws.subcriptions.orderbook.update.data_inside?.includes(',')) {
          // Check if channel message should be ignored ('ignore_if').
          if (_ws.subcriptions.orderbook.update.ignore_if != undefined) {
            for (const [ key, value ] of _ws.subcriptions.orderbook.update.ignore_if) {
              if (msg[key] === value) return;
            }
          }

          msg
          .slice(..._ws.subcriptions.orderbook.update.data_inside.split(','))
          .forEach(x => handle_orderbook_msg(format_orderbook_msg(x, _ws), _prom, _ws, ws));
          return;
  
        } else if (_ws.subcriptions.orderbook.update.data_inside_arr && 
        _ws.subcriptions.orderbook.update.data_inside_arr_inside) {
          // Check if channel message should be ignored ('ignore_if').
          if (_ws.subcriptions.orderbook.update.ignore_if != undefined) {
            for (const [ key, value ] of _ws.subcriptions.orderbook.update.ignore_if) {
              if (msg[key] === value) return;
            }
          }

          let _base_upd = Object.keys(msg)
          .reduce((s, k) => {
            if (k != _ws.subcriptions.orderbook.update.data_inside_arr_inside)
              s[k] = msg[k];
            return s;
          }, {});
          
          msg[_ws.subcriptions.orderbook.update.data_inside_arr_inside]
          .forEach(upd => {
            handle_orderbook_msg(format_orderbook_msg({ ..._base_upd, ...upd }, _ws), _prom, _ws, ws);
          });
  
          return;
        }

        // Check if channel message should be ignored ('ignore_if').
        if (_ws.subcriptions.orderbook.update.ignore_if != undefined) {
          for (const [ key, value ] of _ws.subcriptions.orderbook.update.ignore_if) {
            if (msg[key] === value) return;
          }
        }
  
        return handle_orderbook_msg(
          format_orderbook_msg((_ws.subcriptions.orderbook.update.data_inside.split('.').reduce((f, k) => f?.[k], msg) || msg), _ws),
          _prom, 
          _ws
        );
      }
    }

    // Handle 'orderbook_snap' message.
    if (_ws.not_handle_orderbook !== true && _ws.subcriptions.orderbook_snap != undefined) {
      let _channel_id = null;
      if (!isNaN(_ws.subcriptions.orderbook_snap.update.channel_id_key)) {
        if (Big(_ws.subcriptions.orderbook_snap.update.channel_id_key).abs().gt(msg.length || -1))
          _channel_id = undefined
        else
          _channel_id = msg.slice(_ws.subcriptions.orderbook_snap.update.channel_id_key)[0]
      } else {
        _channel_id = _ws.subcriptions.orderbook_snap.update.channel_id_key.split('.').reduce((f, k) => f = f?.[k], msg);
      }
      if ((info.orderbook_snap.channel_id || _ws.subcriptions.orderbook_snap.update.channel_id) && (
        _channel_id == info.orderbook_snap.channel_id || 
        (_ws.subcriptions.orderbook_snap.update.channel_id != undefined && // In some cases the orderbook_snap subscription response will carry the snapshot in it, and we need to be able to parse an update (send it to 'orderbook_upd_cache') before receiving the orderbook subscription response.
        _channel_id == _ws.subcriptions.orderbook_snap.update.channel_id.replaceAll('<market>', market.ws))
      )) {
        if (_ws.subcriptions.orderbook_snap.update.data_inside?.includes(',')) {
          msg
          .slice(..._ws.subcriptions.orderbook_snap.update.data_inside.split(','))
          .forEach(x => handle_orderbook_msg(format_orderbook_msg(x, _ws, true), _prom, _ws));
          return;
  
        } else if (_ws.subcriptions.orderbook_snap.update.data_inside_arr && 
        _ws.subcriptions.orderbook_snap.update.data_inside_arr_inside) {
          let _base_upd = Object.keys(msg)
          .reduce((s, k) => {
            if (k != _ws.subcriptions.orderbook_snap.update.data_inside_arr_inside)
              s[k] = msg[k];
            return s;
          }, {});
          
          msg[_ws.subcriptions.orderbook_snap.update.data_inside_arr_inside]
          .forEach(upd => {
            handle_orderbook_msg(format_orderbook_msg({ ..._base_upd, ...upd }, _ws, true), _prom, _ws);
          });
  
          return;
        }
  
        return handle_orderbook_msg(
          format_orderbook_msg((_ws.subcriptions.orderbook_snap.update.data_inside.split('.').reduce((f, k) => f?.[k], msg) || msg), _ws, true),
          _prom, 
          _ws
        );
      }
    }
    
    // Handle 'trades' message.
    if (_ws.not_handle_trades !== true && _ws.subcriptions.trades != undefined) {
      let _channel_id = null;
      if ((!isNaN(_ws.subcriptions.trades?.update?.channel_id_key)) && _ws.subcriptions.trades?.update?.channel_id_key != "") {
        if (Big(_ws.subcriptions.trades.update.channel_id_key).abs().gt(msg.length || -1))
          _channel_id = undefined
        else
          _channel_id = msg.slice(_ws.subcriptions.trades.update.channel_id_key)[0]
      } else {
        _channel_id = _ws.subcriptions.trades.update.channel_id_key.split('.').reduce((f, k) => f = f?.[k], msg);
      }
      if (info.trades.channel_id && _channel_id == info.trades.channel_id) {
        // Check if channel message should be ignored ('ignore_if').
        if (_ws.subcriptions.trades.update.ignore_if != undefined) {
          for (const [ key, value ] of _ws.subcriptions.trades.update.ignore_if) {
            if (msg[key] === value) return;
          }
        }

        // console.log('Raw trades message:',msg);
        return handle_trades_msg(
          format_trades_msg(
            _ws.subcriptions.trades.update.data_inside != undefined ? 
              _ws.subcriptions.trades.update.data_inside.split('.').reduce((f, k) => f = f?.[k], msg) : 
                msg,
            _ws
          ),
          _ws
        );
      }
    }
    
    // Handle other updates:
    if (_ws.other_updates != undefined) {
      const updts = Object.values(_ws.other_updates);
      for (const upd of updts) {
        if (msg[upd.identifier_key] != undefined && 
        (upd.identifier_value == undefined || msg[upd.identifier_key] == upd.identifier_value)) {
          // Handle the update.

          if (upd.replace_and_respond) {
            let msg_to_respond = JSON.parse(JSON.stringify(msg));

            for (const key of (upd.to_delete_from_object || []))
              delete msg_to_respond[key];

            msg_to_respond = JSON.stringify(msg_to_respond)
            .replace(upd.to_replace, upd.replace_with);

            ws.send(msg_to_respond);
            return;
          }

          break;
        }
      }
    }

    // WebSocket messages to ignore.
    if (_ws.msgs_to_ignore != undefined &&
    _ws.msgs_to_ignore.some(([ key, value ]) => msg[key] && (value == undefined || msg[key] == value)))
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

  // console.log('base:',base);
  // console.log('quote:',quote);

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

  market.ws = (exc.makert_prefix || "") + market.ws;
  market.rest = (exc.makert_prefix || "") + market.rest;

  // console.log('market:',market);

  // Obtem os pares disponíveis da exchange.
  let raw_markets = null;
  try {
    await Promise.race([
      new Promise((resolve, reject) => setTimeout(reject, (exc.rest.timeout || 5000))),
      fetch(
        (exc.rest.url + exc.rest.endpoints.available_pairs.path)
        .replaceAll('<market>', market.rest)
      )
      .then(r => r.json())
      .then(r => {
        // console.log('Raw markets response:',r);
        if (r?.[exc.rest.error.key] != undefined) {
          let really_an_error = false;
          
          if (exc.rest.error.is_array) {
            really_an_error = (r[exc.rest.error.key].length > 0);
          } else if (exc.rest.error.value_not != undefined) {
            really_an_error = (r[exc.rest.error.key] != exc.rest.error.value_not);
          } else {
            really_an_error = (exc.rest.error.value == undefined || r[exc.rest.error.key] == exc.rest.error.value);
          }

          if (really_an_error) throw { endpoint: 'available_pairs', error: r };
        }

        r = (exc.rest.endpoints.available_pairs.response.data_inside.split('.').reduce((f, k) => f = f?.[k], r) || r);

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
  let _conn_prom = (exc.ws2 != undefined ? Promise.all([ connect(exc.ws), connect(exc.ws2) ]) : connect(exc.ws));
  try { await _conn_prom } 
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

  // Tenta fazer a requisição incial de trades com um TIMEOUT.
  if (exc.rest.endpoints?.trades != undefined) {
    try {
      await Promise.race([
        new Promise((resolve, reject) => setTimeout(reject, (exc.rest.timeout || 5000), "TIMEOUT.")),
        fetch(
          (exc.rest.url + exc.rest.endpoints.trades.path)
          .replaceAll('<market>', market.rest)
          .replace('<since>', since)
        )
        .then(r => r.json())
        .then(r => {
          if (r?.[exc.rest.error.key] != undefined) {
            let really_an_error = false;
            
            if (exc.rest.error.is_array) {
              really_an_error = (r[exc.rest.error.key].length > 0);
            } else if (exc.rest.error.value_not != undefined) {
              really_an_error = (r[exc.rest.error.key] != exc.rest.error.value_not);
            } else {
              really_an_error = (exc.rest.error.value == undefined || r[exc.rest.error.key] == exc.rest.error.value);
            }
    
            if (really_an_error) throw { endpoint: 'available_pairs', error: r };
          }
          // console.log('Raw init_trades response:',r);

          if (exc.rest.endpoints.trades.response.get_first_value)
            r = Object.values(r)[0];
          else
            r = (exc.rest.endpoints.trades.response.data_inside.split('.').reduce((f, k) => f = f?.[k], r) || r);
    
          if (exc.rest.endpoints.trades.response.foreach_concat_inside != undefined) {
            const ck = exc.rest.endpoints.trades.response.foreach_concat_inside; // concat key
            r = r.reduce((s, v) => [ ...s, ...v[ck]], []);
          }
    
          init_trades = r;
        })
      ]);
    } catch (err) {
      console.log('[E] Initial trades snapshot request:',err);
      throw 'Initial trades snapshot request failed.'
    }
    
    // Set trades from initial snapshot.
    trades = (exc.rest.endpoints.trades.response.newer_first ? init_trades.reverse() : init_trades)
    .map(t => {
      let timestamp = t[exc.rest.endpoints.trades.response.timestamp];

      if (exc.timestamp_ISO_format || exc.rest.endpoints.trades.response.timestamp_ISO_format)
        timestamp = new Date(timestamp).getTime();
      else if (exc.timestamp_in_seconds || exc.rest.endpoints.trades.response.timestamp_in_seconds)
        timestamp *= 1e3;
      else if (exc.timestamp_in_micro || exc.rest.endpoints.trades.response.timestamp_in_micro)
        timestamp /= 1e3;

      const _t_resp = exc.rest.endpoints.trades.response;

      let obj = {
        timestamp,
        is_buy: undefined,
        price: t[_t_resp.price],
        amount: t[_t_resp.amount]
      };

      if (_t_resp.is_buy_key != undefined) {
        obj.is_buy = (t[_t_resp.is_buy_key] != undefined && (_t_resp.is_buy_value == undefined || t[_t_resp.is_buy_key] == _t_resp.is_buy_value));
      
      } else if (_t_resp.is_buy_positive_amount === true) {
        obj.is_buy = Big(obj.amount).gt(0);
        obj.amount = Big(obj.amount).abs().toFixed();

      } else {
        throw "[E] Parsing trades response: Can not determine trade side."
      }

      if (exc.rest.endpoints.trades.response.trade_id_key != undefined)
        obj.trade_id = t[exc.rest.endpoints.trades.response.trade_id_key];

      if (exc.trades_custom_id)
        obj.custom_id = '' + obj.timestamp + obj.is_buy + obj.price + obj.amount;
        // obj.custom_id = Object.values(t).filter(v => v != obj.trade_id).join('');

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
        // Check for newer trades (usualy when using 'since' parameter)
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
                .replaceAll('<market>', market.rest)
                .replace('<since>', since)
                .replace('<page_id>', trades[trades.length-1]['_'+_pagination.page_id]) // Newer trade id.
              )
              .then(r => r.json())
              .then(r => {
                if (r?.[exc.rest.error.key] != undefined) {
                  let really_an_error = false;
                  
                  if (exc.rest.error.is_array) {
                    really_an_error = (r[exc.rest.error.key].length > 0);
                  } else if (exc.rest.error.value_not != undefined) {
                    really_an_error = (r[exc.rest.error.key] != exc.rest.error.value_not);
                  } else {
                    really_an_error = (exc.rest.error.value == undefined || r[exc.rest.error.key] == exc.rest.error.value);
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
              obj.custom_id = '' + obj.timestamp + obj.is_buy + obj.price + obj.amount;
              // obj.custom_id = Object.values(t).filter(v => v != obj.trade_id).join('');
        
            const _pagination = exc.rest.endpoints.trades.response.pagination;
            if (_pagination?.page_id != undefined)
              obj['_'+_pagination.page_id] = t[_pagination.page_id];
        
            return obj;
          })
          .filter(t => { // Evita trades repetidos.
            const _key = exc.rest.endpoints.trades.response.trade_id_key != undefined ? 'trade_id' : 'custom_id';
            return trades.every(rt => rt[_key] != t[_key]);
          });
          
          if (exc.rest.endpoints.trades.response.newer_first) {
            trades = [ ...trades, ...newer_trades.reverse() ];
            trades_resp_arr_size = newer_trades.length;
          } else {
            trades = [ ...trades, ...newer_trades ];
            trades_resp_arr_size = newer_trades.length;
          }
        }

        console.log('[!] Got all necessary trades: trades_resp_arr_size=',trades_resp_arr_size);

      } else {
        // Check for older trades
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
                .replaceAll('<market>', market.rest)
                .replace('<since>', since)
                .replace('<page_id>', older_trade['_'+_pagination.page_id])
              )
              .then(r => r.json())
              .then(r => {
                if (r?.[exc.rest.error.key] != undefined) {
                  let really_an_error = false;
                  
                  if (exc.rest.error.is_array) {
                    really_an_error = (r[exc.rest.error.key].length > 0);
                  } else if (exc.rest.error.value_not != undefined) {
                    really_an_error = (r[exc.rest.error.key] != exc.rest.error.value_not);
                  } else {
                    really_an_error = (exc.rest.error.value == undefined || r[exc.rest.error.key] == exc.rest.error.value);
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
              obj.custom_id = '' + obj.timestamp + obj.is_buy + obj.price + obj.amount;
              // obj.custom_id = Object.values(t).filter(v => v != obj.trade_id).join('');
        
            const _pagination = exc.rest.endpoints.trades.response.pagination;
            if (_pagination?.page_id != undefined)
              obj['_'+_pagination.page_id] = t[_pagination.page_id];
        
            return obj;
          })
          .filter(t => { // Evita trades repetidos.
            const _key = exc.rest.endpoints.trades.response.trade_id_key != undefined ? 'trade_id' : 'custom_id';
            return trades.every(rt => rt[_key] != t[_key]);
          });

          if (exc.rest.endpoints.trades.response.newer_first) {
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

    // Evita trades repetidos, removendo os trades obtidos na requisição acima dos trades em cache.
    let _t_ws = exc.ws2 != undefined && exc.ws2.subcriptions.trades ? exc.ws2 : exc.ws;
    trades_upd_cache = trades_upd_cache.filter(t => { 
      if (_t_ws.subcriptions.trades.update.id_should_be_higher)
        return trades.length == 0 || t.trade_id > trades[trades.length-1].trade_id;

      const _key = _t_ws.subcriptions.trades.update.trade_id_key != undefined ? 'trade_id' : 'custom_id';
      return trades.every(rt => rt[_key] != t[_key]);
    });

    console.log('trades from init_trades:',trades);
    console.log('cached trades:',trades_upd_cache);

    // Apply cached trades updates.
    if (trades_upd_cache.length > 0) {
      trades = [
        ...(exc.rest.endpoints.trades.response.newer_first ? trades.reverse() : trades), 
        ...trades_upd_cache
      ];
      trades_upd_cache = [];
    }
    
  } else {
    trades = [];
  }

  // Tenta fazer requisição inicial do orderbook, se necessario.
  if (exc.rest.endpoints.orderbook) {
    let _rest_update_last_nonce_key = exc.rest.endpoints.orderbook.response.last_update_nonce;
    let _ws_update_last_nonce_key = (exc.ws.subcriptions?.orderbook?.update?.last_upd_nonce_key || exc.ws2.subcriptions?.orderbook?.update?.last_upd_nonce_key);
    do {
      // console.log('first cached ob update nonce:',(orderbook_upd_cache[0]?.last_update_nonce));
      // console.log('initial ob nonce:',init_orderbook?.[_rest_update_last_nonce_key],'\n');

      try {
        init_orderbook = await Promise.race([
          new Promise((resolve, reject) => setTimeout(reject, exc.rest.timeout, "TIMEDOUT.")),
          fetch(
            (exc.rest.url + exc.rest.endpoints.orderbook.path)
            .replaceAll('<market>', market.rest)
          )
          .then(r => r.json())
          .then(r => {
            if (r?.[exc.rest.error.key] != undefined) {
              let really_an_error = false;
              
              if (exc.rest.error.is_array) {
                really_an_error = (r[exc.rest.error.key].length > 0);
              } else if (exc.rest.error.value_not != undefined) {
                really_an_error = (r[exc.rest.error.key] != exc.rest.error.value_not);
              } else {
                really_an_error = (exc.rest.error.value == undefined || r[exc.rest.error.key] == exc.rest.error.value);
              }
    
              if (really_an_error) throw { endpoint: 'available_pairs', error: r };
            }
    
            r = (r?.[exc.rest.endpoints.orderbook.response.data_inside] || r);
    
            return r;
          })
        ]);

      } catch (error) {
        console.log('[E] Initial orderbook snapshot request:',error);
        throw 'Initial orderbook snapshot request failed.'
      }

    } while (_rest_update_last_nonce_key != undefined &&
    _ws_update_last_nonce_key != undefined &&
    (orderbook_upd_cache[0]?.last_update_nonce == undefined || 
    Big(orderbook_upd_cache[0].last_update_nonce).gt(init_orderbook[_rest_update_last_nonce_key])));
    
    // console.log('Final:');
    // console.log('first cached ob update nonce:',(orderbook_upd_cache[0].last_update_nonce));
    // console.log('initial ob nonce:',init_orderbook?.[_rest_update_last_nonce_key],'\n');
  }
  
  // If got initial orderbook, set initial orderbook.
  if (init_orderbook) {
    // Parse 'timestamp'.
    let timestamp = init_orderbook?.[exc.rest.endpoints.orderbook.response.timestamp];
    if (exc.rest.endpoints.orderbook.response.timestamp_in_micro)
      timestamp /= 1e3;
    else if (exc.rest.endpoints.orderbook.response.timestamp_in_seconds)
      timestamp *= 1e3;

    orderbook = {
      asks: Object.fromEntries(init_orderbook[exc.rest.endpoints.orderbook.response.asks]),
      bids: Object.fromEntries(init_orderbook[exc.rest.endpoints.orderbook.response.bids]),
      timestamp,
      last_update_nonce: init_orderbook?.[exc.rest.endpoints.orderbook.response.last_update_nonce]
    };
  }
}

// export default syncronizer;

// Debugging 'syncronizer'.
syncronizer()
.then(() => {
  // console.log('orderbook:',orderbook);
  // console.log('trades:',trades);

  const everySecond = () => {
    // Set time variables.
    const timestamp = Date.now();
    const second = Math.floor(timestamp / 1e3);
    const data_time = second - delay_time_in_seconds;

    // Call 'everySecond' again at each new second.
    setTimeout(everySecond, (second + 1) * 1e3 - timestamp);
  
    // Trades that ocurred in the last second.
    const trades_to_post = trades
    .filter(t => 
      t.timestamp > (data_time - 1) * 1e3 &&
      t.timestamp <= data_time * 1e3
    )
    .map(t => {
      delete t.trade_id;
      delete t.custom_id;

      // Remove any key started with "_".
      Object.keys(t).forEach(k => { if (k[0] == '_') delete t[k]; });

      return t;
    });

    // If did not received a new orderbook update do not wait until a new update comes in to update 'delayed_orderbook'.
    if (orderbook != null && orderbook.timestamp < (second - 1) * 1e3 && (delayed_orderbook == null || delayed_orderbook.timestamp != orderbook.timestamp)) {
      delayed_orderbook = {
        asks: Object.entries(orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 25),
        bids: Object.entries(orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 25),
        timestamp: orderbook.timestamp
      };
      orderbooks.unshift(delayed_orderbook);
    }

    const orderbook_to_post = orderbooks.find(ob => ob.timestamp <= data_time * 1e3) || delayed_orderbook;
  
    // Log everything. (Just for debug purposes...)
    if (orderbook_to_post != null) 
      console.log({
        asks: orderbook_to_post.asks.slice(0, 5),
        bids: orderbook_to_post.bids.slice(0, 5),
        book_timestamp: orderbook_to_post.timestamp,
        trades: trades_to_post,
        second: data_time,
        timestamp
      });
    else 
      console.log('orderbook_to_post:',orderbook_to_post);
  
    // // A simpliflied version of orderbook, w/ 25 depth.
    // _orderbook = {
    //   asks: Object.entries(orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 25),
    //   bids: Object.entries(orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 25),
    //   timestamp: orderbook.timestamp
    // };
  
    // Remove anything older then ('delay_time_in_seconds' + 2) seconds from 'trades'.
    trades = trades.filter(t => t.timestamp > (second - (delay_time_in_seconds + 2)) * 1e3);
    
    // Remove anything older then ('delay_time_in_seconds' + 2) seconds from 'orderbooks'.
    orderbooks = orderbooks.filter(ob => ob.timestamp > (second - (delay_time_in_seconds + 2)) * 1e3);
  };
  setTimeout(everySecond, 1e3 - Date.now() % 1e3);
})
.catch(err => {
  console.log(err,'\nExiting...');
  process.exit(1);
});