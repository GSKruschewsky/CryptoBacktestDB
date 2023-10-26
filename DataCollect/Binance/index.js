const WebSocket = require("ws");
const fetch = require("node-fetch");

const exportToS3 = require("../../exporterApp/src/index");

const base = "BTC";
const quote = "USDT";

module.exports = function (base, quote) {
  const market = (base+quote).toLowerCase();

  const ws_url = 'wss://stream.binance.com:9443/stream?streams='+market+'@trade/'+market+'@depth20';
  const ws = new WebSocket(ws_url);

  let trades = null;

  ws.on('close', () => {
    console.log('[!] WebSocket closed.');
  });

  ws.on('error', (err) => {
    console.log('[E] WebSocket :',err);
  });

  ws.on('open', () => {
    console.log('[!] WebSocket opened.');
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
        // console.log('\n'+JSON.stringify({ time: Date.now(), orderbook, trades }));
        let time = Date.now();
        let time_str = new Date(time - 60e3*60*3).toISOString().split('.')[0];
        exportToS3("crypto-backtest-db", { time, orderbook, trades }, `Binance_${base}-${quote}_${time_str}`);
      }

      trades = [];
      
      return;
    }

    console.log('WebSocket unexpected message:', msg);
    process.exit();
  });
};

