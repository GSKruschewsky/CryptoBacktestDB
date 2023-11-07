import WebSocket from 'ws';
import Big from 'big.js';
import fetch from 'node-fetch';
import exchanges from './Exchanges/config.json' assert { type: "json" };

// Isso deve ser feito usando parametros.
const exchange = 'Binance-SPOT';
const base = 'BTC';
const quote = 'USDT';

let orderbook = null;
let orderbook_req_id = null;
let orderbook_msg_type = null;
let orderbook_upd_cache = [];

let trades = null;
let trades_req_id = null;
let trades_msg_type = null;
let trades_upd_cache = [];

// Define o obejto 'exchange' que será usado.
const exc = exchanges[exchange];
let market = base + exc.separator + quote;
if (exc.isMarketUpper)
  market = market.toUpperCase();
else
  market = market.toLowerCase();

orderbook_msg_type = exc.ws.msg_type.orderbook.replace('<market>', exc.ws.isMarketUpper ? market.toUpperCase() : market);
trades_msg_type = exc.ws.msg_type.trades.replace('<market>', exc.ws.isMarketUpper ? market.toUpperCase() : market);

let ws_req_nonce = 0;

function apply_orderbook_upd (upd) {
  // Validate updates.
  if (upd.last_update_nonce && upd.last_update_nonce <= orderbook.last_update_nonce)
    return;
  
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
  orderbook.timestamp = upd.timestamp;
  orderbook.last_update_nonce = upd.last_update_nonce;
}

function handle_orderbook_msg (msg) {
  // console.log('Book update:',msg);
  if (msg.is_snapshot) {
    orderbook = {
      asks: Object.fromEntries(msg.asks),
      bids: Object.fromEntries(msg.bids),
      timestamp: msg.timestamp,
      last_update_nonce: msg.last_update_nonce
    };
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
    trades_upd_cache = [ ...trades_upd_cache, ...msg ];
  } else {
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

  // Define if this orderbook message is an updade or a snapshot.
  let is_snapshot = false;
  if (exc.ws.msg.orderbook.snapshot_identifier_key && msg[exc.ws.msg.orderbook.snapshot_identifier_key]) {
    if (exc.ws.msg.orderbook.snapshot_identifier_value)
      is_snapshot = (msg[exc.ws.msg.orderbook.snapshot_identifier_key] == exc.ws.msg.orderbook.snapshot_identifier_value)
    else 
      is_snapshot = true;
  }

  // Construct the formatted message.
  let formatted = {
    asks: msg[exc.ws.msg.orderbook.asks],
    bids: msg[exc.ws.msg.orderbook.bids],
    timestamp: msg[exc.ws.msg.orderbook.timestamp],
    is_snapshot
  };

  // Set first and last update_nonces if required.
  if (exc.ws.msg.orderbook.first_upd_nonce_key)
    formatted.first_update_nonce = msg[exc.ws.msg.orderbook.first_upd_nonce_key];
  
  if (exc.ws.msg.orderbook.last_upd_nonce_key)
    formatted.last_update_nonce = msg[exc.ws.msg.orderbook.last_upd_nonce_key];

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
  
  // Se recebe cada trade como um objeto unico, insere esse trade dentro de um array.
  if (exc.ws.msg.trades.receive_separately_trades_as_obj) 
    msg = [ msg ];

  // Retorna trades formatados.
  return msg.map(t => ({
    timestamp: t[exc.ws.msg.trades.timestamp],
    is_buy: (t[exc.ws.msg.trades.is_buy_key] == exc.ws.msg.trades.is_buy_value),
    price: t[exc.ws.msg.trades.price],
    amount: t[exc.ws.msg.trades.amount]
  }));
}

function connect () {
  // Reseta as variaveis.
  orderbook = null;
  trades = null;

  // Cria variaveis para monitorar o status da subscrição do 'orderbook' e 'trades'.
  let subscribed_to = { orderbook: false, trades: false };

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

  // Quando perdemos a conexão iremos tentar nos conectar novamente.
  ws.on('close', connect);

  // Quando recebermos um erro do WebSocket, iremos logar o erro e encerrar o processo.
  ws.on('error', err => {
    // Também devemos enviar um e-mail aqui.
    console.log('WebSocket error:',err);
    process.exit();
  });

  // Quando a conexão abrir devemos nos escrever as atualizações de 'orderbook' e 'trades' da exchange.
  ws.on('open', () => {
    ws.send(
      exc.ws.subcriptions.orderbook
      .replace('<market>', exc.ws.isMarketUpper ? market.toUpperCase() : market)
      .replace('<ws_req_id>', ++ws_req_nonce)
    );
    orderbook_req_id = ws_req_nonce;
    
    ws.send(
      exc.ws.subcriptions.trades
      .replace('<market>', exc.ws.isMarketUpper ? market.toUpperCase() : market)
      .replace('<ws_req_id>', ++ws_req_nonce)
    );
    trades_req_id = ws_req_nonce;
  });

  // Finalmente, aqui processaremos os dados recebidos do servidor.
  ws.on('message', msg => {
    // Try to parse mesage as a JSON.
    try { msg = JSON.parse(msg); } catch (e) { msg = msg.toString(); }

    // Handle subscription response.
    if (msg[exc.ws.msg.id] == orderbook_req_id) {
      subscribed_to.orderbook = true;
      if (subscribed_to.trades && _prom) _prom.resolve(); // Se também já estiver incrito a 'trades' resolve a promessa.
      return console.log('[!] Successfully subscribed to orderbook updates.');
    }

    // Handle subscription response.
    if (msg[exc.ws.msg.id] == trades_req_id) {
      subscribed_to.trades = true;
      if (subscribed_to.orderbook && _prom) _prom.resolve(); // Se também já estiver incrito a 'orderbook' resolve a promessa.
      return console.log('[!] Successfully subscribed to trades updates.');
    }

    // Handle orderbook message.
    if (msg[exc.ws.msg.type] == orderbook_msg_type)
      return handle_orderbook_msg(
        format_orderbook_msg(exc.ws.msg.data_inside ? msg[exc.ws.msg.data_inside] : msg)
      );
    
    // Handle trades message.
    if (msg[exc.ws.msg.type] == trades_msg_type) 
      return handle_trades_msg(
        format_trades_msg(exc.ws.msg.data_inside ? msg[exc.ws.msg.data_inside] : msg)
      );

    // Recebemos uma mensagem inesperada do servidor, devemos logar e finalizar o processo.
    console.log('WebSocket ('+exchange+' '+market+') unexpected message:',msg);
    process.exit();
  });

  // Então retornamos a promessa criada.
  return prom;
}

async function sync_data () {
  // Tenta se conectar e se inscrever as atualizações da exchange.
  console.log('Connecting to '+exchange+' '+market+'...');
  try { await connect(); } 
  catch (err) {
    console.log('[E] Connecting:',err);
    throw 'Connection failed.'
  }
  console.log('[!] Connected.');

  // Define varibales to store the initial snapshot.
  let init_trades = null;
  let init_orderbook = null;

  // 'since' represents the start of the second that we are syncing.
  let since = Math.floor(Date.now() / 1e3) * 1e3;

  // Set promise to get initial trades snapshot.
  let _proms = [
    fetch(
      (exc.rest.url + exc.rest.endpoints.trades.path)
      .replace('<market>', exc.rest.isMarketUpper ? market.toUpperCase() : market)
      .replace('<since>', since)
    )
    .then(r => r.json())
    .then(r => init_trades = r)
  ];

  // Set promise to get initial orderbook snapshot. (If required)
  if (exc.rest.endpoints.orderbook)
    _proms.push(
      fetch(
        (exc.rest.url + exc.rest.endpoints.orderbook.path)
        .replace('<market>', exc.rest.isMarketUpper ? market.toUpperCase() : market)
      )
      .then(r => r.json())
      .then(r => init_orderbook = r)
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
  
  // Set trades from initial snapshot.
  trades = init_trades.map(t => ({
    timestamp: t[exc.rest.response.trades.timestamp],
    is_buy: (t[exc.rest.response.trades.is_buy_key] == exc.rest.response.trades.is_buy_value),
    price: t[exc.rest.response.trades.price],
    amount: t[exc.rest.response.trades.amount]
  }));

  // Apply cached trades updates.
  if (trades_upd_cache.length > 0) {
    trades = [ ...trades, ...trades_upd_cache ];
    trades_upd_cache = [];
  }
  
  // If got initial orderbook, set initial orderbook.
  if (init_orderbook) {
    orderbook = {
      asks: Object.fromEntries(init_orderbook[exc.rest.response.orderbook.asks]),
      bids: Object.fromEntries(init_orderbook[exc.rest.response.orderbook.bids]),
      timestamp: init_orderbook?.[exc.rest.response.orderbook.timestamp],
      last_update_nonce: init_orderbook?.[exc.rest.response.orderbook.last_update_nonce]
    };

    // Apply cached orderbook updates.
    while (orderbook_upd_cache.length > 0) {
      apply_orderbook_upd(orderbook_upd_cache[0]);
      orderbook_upd_cache.shift();
    }
  }
}

sync_data()
.then(() => {
  const everySecond = () => {
    // Set time variables.
    const timestamp = Date.now();
    const second = Math.floor(timestamp / 1e3);

    // Call 'everySecond' again at each new second.
    setTimeout(everySecond, (second + 1) * 1e3 - timestamp);
  
    // A simpliflied version of orderbook, w/ 25 depth.
    const _orderbook = {
      asks: Object.entries(orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 25),
      bids: Object.entries(orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 25),
      timestamp: orderbook.timestamp
    };
  
    // Trades that ocurred in the last second.
    const _trades = trades.filter(t => 
      t.timestamp >= (second - 1) * 1e3 &&
      t.timestamp < second * 1e3
    );
  
    // Log everything. (Just for debuging...)
    console.log({
      asks: _orderbook.asks.slice(0, 5),
      bids: _orderbook.bids.slice(0, 5),
      book_timestamp: _orderbook.timestamp,
      trades: _trades,
      second,
      timestamp
    });
  
    // Remove anything older then 3 seconds from 'trades'.
    trades = trades.filter(t => t.timestamp > (second - 3) * 1e3);
  };

  setTimeout(everySecond, 1e3 - Date.now() % 1e3);
})
.catch(err => {
  console.log(err,'\nExiting...');
  process.exit(1);
});