import WebSocket from "ws";
import fetch from "node-fetch";
import Big from "big.js";
import crypto from "crypto";
import exportToS3 from "../../exporterApp/src/index.js";
import sendMail from "../../helper/sendMail.js";
import dotenv from "dotenv";
dotenv.config();

function get_date (ts = Date.now()) {
  ts -= 60e3*60*3;
  return `${new Date(ts).toLocaleString('pt-BR', { timeZone: 'UTC' }).replace(',','')}.${(`000${ts % 1e3}`).slice(-3)}`;
}

// // Mostrar data no 'console.log'.
// const old_log = console.log;
// const new_log = (...args) => old_log(...[ `${get_date()} -`, ...args ]);
// console.log = new_log;
// // 

let day_data = [];
let trades = null;
let _orderbook = null;
let _validation_list = [];
let market_synced = false;
let ping_no_answer = false;
let last_day = new Date(Date.now() - 60e3*60*3).getUTCHours();
let last_sent_data_time = null;
let base, quote, market, mkt_name, ws, ws_url, newSecTimeout;

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
  market_synced = false;
  ping_no_answer = false;

  ws = new WebSocket(ws_url);

  ws.on('ping', data => ws.pong(data));

  ws.on('close', () => {
    clearTimeout(newSecTimeout);
    console.log('[!] ('+mkt_name+') WebSocket closed.');
    connectToExchange();
  });

  ws.on('error', (err) => {
    console.log(`[E] (${mkt_name}) > WebSocket error:`,err);
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

  ws.on('open', () => {
    console.log('[!] ('+mkt_name+') WebSocket open.\n');

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

      if ((!market_synced) && _orderbook) {
        process.stdout.moveCursor(0, 2); // Move the cursor down two lines
        market_synced = true;
      }

      return;
    }

    if (msg.type == "subscriptions" || msg.type == "last_match") return;
  
    console.log(`[E] (${mkt_name}) > WebSocket unexpected message:`,msg);
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
  market = `${base}-${quote}`;
  mkt_name = `Coinbase ${base}/${quote}`;
  ws_url = "wss://ws-feed.exchange.coinbase.com";
  connectToExchange();
}

function newSecond () {
  // New second.
  if (market_synced) {
    let time = Date.now();

    // Checks if it is a new day.
    let today = new Date(time - 60e3*60*3).getUTCHours();
    if (today != last_day) {
      last_day = today;
      newDay(time);
    }

    if (_orderbook && trades) {
      if (ping_no_answer) {
        // Não recebemos uma resposta do ping.
        console.log(`[E] (${mkt_name}) > Servidor não respondeu ao ping enviado.`);
        sendMail(
          process.env.SEND_ERROR_MAILS, 
          `${mkt_name}`,
          'Servidor não respondeu ao ping enviado.'
        ).catch(console.error);
        process.exit();
      }
      ping_no_answer = true;
      ws.ping();

      let orderbook = {
        asks: Object.entries(_orderbook.asks).sort((a, b) => Big(a[0]).cmp(b[0])).slice(0, 20),
        bids: Object.entries(_orderbook.bids).sort((a, b) => Big(b[0]).cmp(a[0])).slice(0, 20)
      };

      let obj = { orderbook, trades };

      _validation_list.push(JSON.stringify(obj));
      _validation_list = _validation_list.slice(-100);

      obj.time = Math.round(time / 1e3);

      if (_validation_list.length == 100) {
        if (!_validation_list.some(json => json != _validation_list[0])) {
          console.log(`[E] (${mkt_name}) > As ultimas 100 postagens foram iguais!`);
          sendMail(
            process.env.SEND_ERROR_MAILS, 
            `${mkt_name}`,
            'As ultimas 100 postagens foram iguais!'
          ).catch(console.error);
          process.exit();
        }
      }

      day_data.push(JSON.stringify(obj));
      process.stdout.moveCursor(0, -2); // Move the cursor up two lines
      process.stdout.write(`Last save to S3: ${(last_sent_data_time ? get_date(last_sent_data_time) : '')}\r`);
      process.stdout.write(`\nLast market snapshot: ${get_date(time)}\r\n`);
    }

    trades = [];
  }

  newSecTimeout = setTimeout(newSecond, (parseInt(Date.now() / 1e3) + 1) * 1e3 - Date.now());
}

function newDay (time) {
  // New day, save data and reset 'day_data'.
  const day_str = new Date(time - 60e3*60*3).toISOString().split('T')[0];
  const filename = `Coinbase_${base}-${quote}_${day_str}`;

  exportToS3("crypto-backtest-db", `[${day_data.join(',')}]`, filename)
  .then(r => {
    // console.log(`[!] Maket data sent to S3: ${filename}`);
    last_sent_data_time = time;
  })
  .catch(err => {
    console.log(`[E] ${mkt_name} > exportToS3 - Failed to upload file:`,err);
    sendMail(
      process.env.SEND_ERROR_MAILS, 
      mkt_name,
      'Bot falhou ao enviar arquivo para AWS S3!',
    ).catch(console.error);
    process.exit();
  });

  day_data = [];
}

watchMarket("BTC", "USD");

// export default watchMarket;