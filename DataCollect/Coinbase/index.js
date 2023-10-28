const WebSocket = require("ws");
const fetch = require("node-fetch");
const Big = require("big.js");
const crypto = require('crypto');
require('dotenv').config({ path: "../../.env" });
// const exportToS3 = require("../../exporterApp/src/index");
const sendMail = require("../../helper/sendMail");

let trades = null;
let _orderbook = null;
let _validation_list = [];
let ping_no_answer = false;
let market, mkt_name, ws_url, newSecTimeout;

function getWsAuthentication () {
  var key = process.env.CB_API_KEY;
  var secret = process.env.CB_API_SECRET;
  var passphrase = process.env.CB_API_PASSPHRASE;

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

function connectToExchange () {
  trades = null;
  _orderbook = null;
  _validation_list = [];
  ping_no_answer = false;

  const ws = new WebSocket(ws_url);

  ws.on('ping', data => ws.pong(data));

  ws.on('close', () => {
    clearTimeout(newSecTimeout);
    console.log('[!] ('+mkt_name+') WebSocket closed.');
    connectToExchange();
  });

  ws.on('error', (err) => {
    console.log(`[E] (Coinbase ${mkt_name}) > WebSocket error:`,err);
    sendMail(
      process.env.SEND_ERROR_MAILS, 
      `Coinbase ${mkt_name}`,
      `WebSocket error: ${err}`
    ).catch(console.error);
    process.exit();
  });

  ws.on('pong', () => {
    ping_no_answer = false;
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
        let { time, side, size: amount, price } = msg;
        trades.push({ time: new Date(time).getTime(), side, amount, price });
      }
      return;
    }

    if (msg.type == "subscriptions" || msg.type == "last_match") return;
  
    console.log(`[E] (Coinbase ${mkt_name}) > WebSocket unexpected message:`,msg);
    sendMail(
      process.env.SEND_ERROR_MAILS, 
      `Coinbase ${mkt_name}`,
      `WebSocket unexpected message: ${msg}`
    ).catch(console.error);
    process.exit();
  });

  newSecTimeout = setTimeout(newSecond, (parseInt(Date.now() / 1e3) + 1) * 1e3 - Date.now());
}

function watchMarket (base, quote) {
  market = `${base}-${quote}`;
  mkt_name = `Coinbase ${base}/${quote}`;
  ws_url = "wss://ws-feed.exchange.coinbase.com";
  connectToExchange();
}

function newSecond () {
  // New second.
  if (_orderbook && trades) {
    if (ping_no_answer) {
      // Não recebemos uma resposta do ping.
      console.log(`[E] (Coinbase ${mkt_name}) > Servidor não respondeu ao ping enviado.`);
      sendMail(
        process.env.SEND_ERROR_MAILS, 
        `Coinbase ${mkt_name}`,
        'Servidor não respondeu ao ping enviado.'
      ).catch(console.error);
      process.exit();
    }
    ping_no_answer = true;
    ws.ping();

    let time = Date.now();
    let time_str = new Date(time - 60e3*60*3).toISOString().split('.')[0];

    let orderbook = {
      asks: Object.entries(_orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 20),
      bids: Object.entries(_orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 20)
    };

    let obj = { orderbook, trades };

    _validation_list.push(JSON.stringify(obj));
    _validation_list = _validation_list.slice(-100);

    obj.time = time;

    if (_validation_list.length == 100) {
      if (!_validation_list.some(json => json != _validation_list[0])) {
        console.log(`[E] (Coinbase ${mkt_name}) > As ultimas 100 postagens foram iguais!`);
        sendMail(
          process.env.SEND_ERROR_MAILS, 
          `Coinbase ${mkt_name}`,
          'As ultimas 100 postagens foram iguais!'
        ).catch(console.error);
        process.exit();
      }
    }

    // exportToS3("crypto-backtest-db", obj, `Coinbase_${base}-${quote}_${time_str}`);
    console.log('time:',time);
    console.log('best_ask:',obj.orderbook.asks[0]);
    console.log('best_bid:',obj.orderbook.bids[0]);
    console.log('trades ('+trades.length+'):',obj.trades,'\n');
  }

  trades = [];

  newSecTimeout = setTimeout(newSecond, (parseInt(Date.now() / 1e3) + 1) * 1e3 - Date.now());
}

watchMarket("BTC", "USD");

// module.exports = watchMarket;