const WebSocket = require("ws");
const fetch = require("node-fetch");
const exportToS3 = require("../../exporterApp/src/index");
const sendMail = require("../../helper/sendMail");
require('dotenv').config({ path: "../../.env" });

let _validation_list = [];

function watchMarket (base, quote) {
  const market = (base+quote).toLowerCase();
  const mkt_name = `Binance ${base}/${quote}`;

  const ws_url = 'wss://stream.binance.com:9443/stream?streams='+market+'@trade/'+market+'@depth20';
  const ws = new WebSocket(ws_url);

  let trades = null;

  ws.on('close', () => {
    console.log('[!] ('+mkt_name+') WebSocket closed.');
  });

  ws.on('error', (err) => {
    console.log('[E] ('+mkt_name+') WebSocket :',err);
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
        trades.push({ market: base+'/'+quote , time, side: (m ? 'sell' : 'buy'), amount, price });
      }
      return;
    }

    if (msg.stream == market+'@depth20') {
      // New orderbook update.
      if (trades) {
        let { lastUpdateId, ...orderbook } = msg.data;
        let time = Date.now();
        let time_str = new Date(time - 60e3*60*3).toISOString().split('.')[0];

        let obj = { time, orderbook, trades };

        _validation_list.push(JSON.stringify(obj));
        _validation_list = _validation_list.slice(-100);

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
        console.log(obj);
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

watchMarket("BTC", "USDT");

// module.exports = watchMarket;