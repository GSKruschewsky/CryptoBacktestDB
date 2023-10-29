const WebSocket = require("ws");
const fetch = require("node-fetch");
const exportToS3 = require("../../exporterApp/src/index");
const sendMail = require("../../helper/sendMail");
require('dotenv').config();

// // Mostrar data no 'console.log'.
// const old_log = console.log;
// const new_log = (...args) => {
//   const ts = Date.now() - 60e3*60*3;
//   const dt = `${new Date(ts).toLocaleString('pt-BR', { timeZone: 'UTC' }).replace(',','')}.${(`000${ts % 1e3}`).slice(-3)} -`;
//   old_log(...[ dt, ...args ]);
// }
// console.log = new_log;
// // 

let trades = null;
let orderbook = null;
let _validation_list = [];
let ping_no_answer = false;
let base, quote, market, mkt_name, ws, ws_url, newSecTimeout;

function connectToExchange () {
  trades = null;
  orderbook = null;
  _validation_list = [];
  ping_no_answer = false;

  ws = new WebSocket(ws_url);

  ws.on('close', () => {
    clearTimeout(newSecTimeout);
    console.log('[!] ('+mkt_name+') WebSocket closed.');
    connectToExchange();
  });

  ws.on('error', (err) => {
    console.log(`[E] WebSocket (${mkt_name}):`,err);
    sendMail(
      process.env.SEND_ERROR_MAILS, 
      `${mkt_name}`, 
      `WebSocket error: ${err}`
    ).catch(console.error);
    process.exit();
  });

  ws.on('pong', () => {
    ping_no_answer = false;
  });

  ws.on('ping', () => {
    ws.pong();
  });

  ws.on('open', () => {
    console.log('[!] ('+mkt_name+') WebSocket open.');
  });

  ws.on('message', (msg) => {
    msg = JSON.parse(msg);

    if (msg.stream == market+'@trade') {
      // New market trade.
      if (trades) {
        let { T: time, q: amount, p: price, m } = msg.data;
        trades.push({ time, side: (m ? 'sell' : 'buy'), amount, price });
      }
      return;
    }

    if (msg.stream == market+'@depth20@100ms') {
      // New orderbook update.
      let { lastUpdateId, ..._orderbook } = msg.data;
      orderbook = _orderbook;
      return;
    }

    console.log(`[E] ${mkt_name} > WebSocket unexpected message:`,msg);
    sendMail(
      process.env.SEND_ERROR_MAILS, 
      `${mkt_name}`,
      `WebSocket unexpected message: ${msg}`
    ).catch(console.error);
    process.exit();
  });
  
  newSecTimeout = setTimeout(newSecond, (parseInt(Date.now() / 1e3) + 1) * 1e3 - Date.now());
}

function watchMarket (_base, _quote) {
  base = _base;
  quote = _quote;
  market = (base+quote).toLowerCase();
  mkt_name = `Binance ${base}/${quote}`;
  ws_url = 'wss://stream.binance.com:9443/stream?streams='+market+'@trade/'+market+'@depth20@100ms';
  connectToExchange();
}

function newSecond () {
  // New second.
  let time = Date.now();
  let time_str = new Date(time - 60e3*60*3).toISOString().split('.')[0];

  if (orderbook && trades) {
    if (ping_no_answer) {
      // Não recebemos uma resposta do ping.
      console.log(`[E] ${mkt_name} > Servidor não respondeu ao ping enviado.`);
      sendMail(
        process.env.SEND_ERROR_MAILS, 
        `${mkt_name}`,
        'Servidor não respondeu ao ping enviado.'
      ).catch(console.error);
      process.exit();
    }
    ping_no_answer = true;
    ws.ping();

    let obj = { orderbook, trades };

    _validation_list.push(JSON.stringify(obj));
    _validation_list = _validation_list.slice(-100);

    obj.time = time;

    if (_validation_list.length == 100) {
      if (!_validation_list.some(json => json != _validation_list[0])) {
        console.log(`[E] ${mkt_name} > As ultimas 100 postagens foram iguais!`);
        sendMail(
          process.env.SEND_ERROR_MAILS, 
          `${mkt_name}`,
          'As ultimas 100 postagens foram iguais!',
        ).catch(console.error);
        process.exit();
      }
    }

    exportToS3("crypto-backtest-db", obj, `Binance_${base}-${quote}_${time_str}`);
    // console.log('time:',time);
    // console.log('best_ask:',obj.orderbook.asks[0]);
    // console.log('best_bid:',obj.orderbook.bids[0]);
    // console.log('trades ('+trades.length+'):',obj.trades,'\n');
  }

  trades = [];

  newSecTimeout = setTimeout(newSecond, (parseInt(Date.now() / 1e3) + 1) * 1e3 - Date.now());
}

watchMarket("BTC", "USDT");

// module.exports = watchMarket;