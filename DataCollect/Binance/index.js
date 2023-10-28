const WebSocket = require("ws");
const fetch = require("node-fetch");
// const exportToS3 = require("../../exporterApp/src/index");
const sendMail = require("../../helper/sendMail");
require('dotenv').config({ path: "../../.env" });

let _validation_list = [];
let trades = null;
let ping_no_answer = false;
let market, mkt_name, ws_url, ws;

function connectToExchange () {
  _validation_list = [];
  trades = null;
  ping_no_answer = false;

  ws = new WebSocket(ws_url);

  ws.on('close', () => {
    console.log('[!] ('+mkt_name+') WebSocket closed.');
    connectToExchange();
  });

  ws.on('error', (err) => {
    console.log(`[E] WebSocket (Binance ${mkt_name}):`,err);
    sendMail(
      process.env.SEND_ERROR_MAILS, 
      `Binance ${mkt_name}`, 
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

    if (msg.stream == market+'@depth20') {
      // New orderbook update.
      if (trades) {
        if (ping_no_answer) {
          // Não recebemos uma resposta do ping.
          console.log(`[E] Binance ${mkt_name} > Servidor não respondeu ao ping enviado.`);
          sendMail(
            process.env.SEND_ERROR_MAILS, 
            `Binance ${mkt_name}`,
            'Servidor não respondeu ao ping enviado.'
          ).catch(console.error);
          process.exit();
        }
        ping_no_answer = true;
        ws.ping();

        let { lastUpdateId, ...orderbook } = msg.data;
        let time = Date.now();
        let time_str = new Date(time - 60e3*60*3).toISOString().split('.')[0];

        let obj = { orderbook, trades };

        _validation_list.push(JSON.stringify(obj));
        _validation_list = _validation_list.slice(-100);

        obj.time = time;

        if (_validation_list.length == 100) {
          if (!_validation_list.some(json => json != _validation_list[0])) {
            console.log(`[E] Binance ${mkt_name} > As ultimas 100 postagens foram iguais!`);
            sendMail(
              process.env.SEND_ERROR_MAILS, 
              `Binance ${mkt_name}`,
              'As ultimas 100 postagens foram iguais!',
            ).catch(console.error);
            process.exit();
          }
        }

        // exportToS3("crypto-backtest-db", obj, `Binance_${base}-${quote}_${time_str}`);
        console.log('time:',time);
        console.log('best_ask:',obj.orderbook.asks[0]);
        console.log('best_bid:',obj.orderbook.bids[0]);
        console.log('trades ('+trades.length+'):',obj.trades,'\n');
      }

      trades = [];
      
      return;
    }

    console.log(`[E] Binance ${mkt_name} > WebSocket unexpected message:`,msg);
    sendMail(
      process.env.SEND_ERROR_MAILS, 
      `Binance ${mkt_name}`,
      `WebSocket unexpected message: ${msg}`
    ).catch(console.error);
    process.exit();
  });
}

function watchMarket (base, quote) {
  market = (base+quote).toLowerCase();
  mkt_name = `Binance ${base}/${quote}`;
  ws_url = 'wss://stream.binance.com:9443/stream?streams='+market+'@trade/'+market+'@depth20';
  connectToExchange();
}

watchMarket("BTC", "USDT");

// module.exports = watchMarket;