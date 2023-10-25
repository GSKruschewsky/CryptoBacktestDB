const WebSocket = require("ws");
const fetch = require("node-fetch");

const base = "BTC";
const quote = "USDT";

const market = (base+quote).toLowerCase();

const ws_url = 'wss://stream.binance.com:9443/stream?streams='+market+'@trade/'+market+'@depth20';
const ws = new WebSocket(ws_url);

let trades = null;
let time = null;

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
      console.log('\n'+JSON.stringify({ time: Date.now(), orderbook, trades }));
      // process.exit();
    }

    trades = [];
    
    return;
  }

  console.log('WebSocket message:', msg);
  process.exit();
});