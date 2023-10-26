const WebSocket = require("ws");
const fetch = require("node-fetch");
const Big = require("big.js");
const crypto = require('crypto');
require('dotenv').config({ path: "../../.env" });
// const exportToS3 = require("../../exporterApp/src/index");

function getWsAuthentication () {
  var key = process.env.CB_API_KEY;
  var secret = process.env.CB_API_SECRET;
  var passphrase = process.env.CB_API_PASSPHRASE;

  // console.log('process.env:',process.env);
  // console.log('secret:',secret);
  // console.log('passphrase:',passphrase);

  // create the json request object
  var timestamp = Date.now() / 1000; // in ms
  var requestPath = '/users/self/verify';
  var body = "";
  var method = 'GET';

  // create the prehash string by concatenating required parts
  var message = timestamp + method + requestPath + body;

  // create a sha256 hmac with the secret
  var hmac = crypto.createHmac('sha256', Buffer.from(secret, 'base64'));

  // sign the require message with the hmac and base64 encode the result
  var signature = hmac.update(message).digest('base64');

  return { signature, key, passphrase, timestamp }
}

function watchMarket (base, quote) {
  const market = `${base}-${quote}`;
  const mkt_name = `Coinbase ${base}/${quote}`;

  const ws_url = "wss://ws-feed.exchange.coinbase.com";
  const ws = new WebSocket(ws_url);

  let trades = null;
  let _orderbook = null;

  ws.on('close', () => {
    console.log('[!] ('+mkt_name+') WebSocket closed.');
  });

  ws.on('error', (err) => {
    console.log('[E] ('+mkt_name+') WebSocket :',err);
  });

  ws.on('open', () => {
    console.log('[!] ('+mkt_name+') WebSocket open.');

    ws.send(JSON.stringify({
      "type": "subscribe",
      "channels": ["level2", "matches"],
      "product_ids": [market],
      ...getWsAuthentication()
    }));
  });

  ws.on('message', (msg) => {
    msg = JSON.parse(msg);

    if (msg.type == "snapshot") {
      // Orderbook snapshot.
      _orderbook = {
        asks: Object.fromEntries(msg.asks.slice(0, 1000)),
        bids: Object.fromEntries(msg.bids.slice(0, 1000)),
        time: msg.time
      };
      last_second = new Date(_orderbook.time).getSeconds();
      return;
    }

    if (msg.type == "l2update") {
      // Orderbook update.
      msg.changes.forEach(([ side, price, amount ]) => {
        let b_side = side == 'buy' ? 'bids' : 'asks';
        if (amount * 1 == 0)
          delete _orderbook[b_side][price];
        else
          _orderbook[b_side][price] = amount;
      });
      _orderbook.time = msg.time;

      return;
    }

    if (msg.type == "match") {
      // New trade.
      if (trades) {
        let { product_id: market, time, side, size: amount, price } = msg;
        trades.push({ market, time: new Date(time).getTime(), side, amount, price });
      }
      return;
    }

    if (msg.type == "subscriptions" || msg.type == "last_match") return;
  
    console.log('[E] ('+mkt_name+') WebSocket unexpected message:', msg);
    process.exit();
  });

  setTimeout(() => {
    // Waits until next second.
    trades = [];

    setInterval(() => {
      // New second.
      if (!_orderbook) return;
      let time = Date.now();

      let orderbook = {
        asks: Object.entries(_orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 20),
        bids: Object.entries(_orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 20)
      };

      let time_str = new Date(time - 60e3*60*3).toISOString().split('.')[0];
      // exportToS3("crypto-backtest-db", { time, orderbook, trades }, `Binance_${base}-${quote}_${time_str}`);
      // console.log({ time, orderbook, trades });

      trades = [];
    }, 1e3);

  }, (parseInt(Date.now() / 1e3) + 1) * 1e3);
}

watchMarket('BTC','USD');

// module.exports = watchMarket;