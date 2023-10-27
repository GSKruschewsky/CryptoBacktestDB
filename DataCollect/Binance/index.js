const WebSocket = require("ws");
const fetch = require("node-fetch");
// const exportToS3 = require("../../exporterApp/src/index");
const sendMail = require("../../helper/sendMail");
require('dotenv').config({ path: "../../.env" });

let _validation_list = [];
let trades = null;
let market, mkt_name, ws_url, ws;

function connectToExchange () {
  _validation_list = [];
  trades = null;

  ws = new WebSocket(ws_url);

  ws.on('close', () => {
    console.log('[!] ('+mkt_name+') WebSocket closed.');
    connectToExchange();
  });

  ws.on('error', (err) => {
    console.log('[E] ('+mkt_name+') WebSocket :',err);
    process.exit();
  });

  ws.on('open', () => {
    console.log('[!] ('+mkt_name+') WebSocket open.');

    setInterval(() => ws.pong(), 60e3);
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
        let { lastUpdateId, ...orderbook } = msg.data;
        let time = Date.now();
        let time_str = new Date(time - 60e3*60*3).toISOString().split('.')[0];

        let obj = { orderbook, trades };

        _validation_list.push(JSON.stringify(obj));
        _validation_list = _validation_list.slice(-100);

        obj.time = time;

        if (_validation_list.length == 100) {
          if (!_validation_list.some(json => json != _validation_list[0])) {
            sendMail(
              process.env.SEND_ERROR_MAILS, 
              "Binance", 
              "[E] As ultimas 100 postagens foram iguais!"
            ).catch(console.error);
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

    sendMail(
      process.env.SEND_ERROR_MAILS, 
      mkt_name, 
      `WebSocket unexpected message: ${msg}`
    ).catch(console.error);
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