import WebSocket from "ws";
import fetch from "node-fetch";
import exportToS3 from "../../exporterApp/src/index.js";
import sendMail from "../../helper/sendMail.js";
import ansi from "ansi";
const cursor = ansi(process.stdout);
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
let orderbook = null;
let _validation_list = [];
let market_synced = false;
let ping_no_answer = false;
let last_day = new Date(Date.now() - 60e3*60*3).getUTCHours();
let last_sent_data_time = null;
let base, quote, market, mkt_name, ws, ws_url, newSecTimeout;

function connectToExchange () {
  trades = null;
  orderbook = null;
  _validation_list = [];
  market_synced = false;
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
    console.log('[!] ('+mkt_name+') WebSocket open.\n');
  });

  ws.on('message', (msg) => {
    msg = JSON.parse(msg);
    // console.log(msg);

    if (msg.stream == market+'@trade') {
      // New market trade.
      if (trades) {
        let { T: time, q: amount, p: price, m } = msg.data;
        trades.push({ time, side: (m ? 'sell' : 'buy'), amount, price });
      }

      if ((!market_synced) && orderbook) {
        console.log('\n'); // Move the cursor down two lines
        market_synced = true;
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
  if (market_synced) {
    let time = Date.now();

    // Checks if it is a new day.
    let today = new Date(time - 60e3*60*3).getUTCHours();
    if (today != last_day) {
      last_day = today;
      newDay(time);
    }

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

      obj.time = Math.round(time / 1e3);

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

      day_data.push(JSON.stringify(obj));

      cursor.up();
      cursor.up();
      cursor.write(`Last save to S3: ${ last_sent_data_time ? get_date(last_sent_data_time) : '' }\n`);
      cursor.write(`Last market snapshot: ${get_date(time)}\n`);
    }

    trades = [];
  }

  newSecTimeout = setTimeout(newSecond, (parseInt(Date.now() / 1e3) + 1) * 1e3 - Date.now());
}

function newDay (time) {
  // New day, save data and reset 'day_data'.
  const day_str = new Date(time - 60e3*60*3).toISOString().split('T')[0];
  const filename = `Binance_${base}-${quote}_${day_str}`;

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

watchMarket("BTC", "USDT");

// export default watchMarket;