import { Kraken } from "node-kraken-api";
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

const kraken = new Kraken();

let day_data = [];
let trades = null;
let current_order_book = null;
let _validation_list = [];
let market_synced = false;
let last_day = new Date(Date.now() - 60e3*60*3).getUTCHours();
let last_sent_data_time = null;
let base, quote, mkt_name, newSecTimeout;

async function watchMarket (_base, _quote) {
  base = _base;
  quote = _quote;
  mkt_name = `Kraken ${base}/${quote}`;

  await kraken.ws.trade()
  .on('update', ([[ price, amount, time, side ]])  => {
    if (trades) {
      let tradedata = { 
        time: time * 1e3, 
        side: (side == "b" ? "buy" : "sell"), 
        amount, 
        price 
      };
      trades.push(tradedata);
    }

    if ((!market_synced) && current_order_book) {
      process.stdout.moveCursor(0, 2); // Move the cursor down two lines
      market_synced = true;
    }
  })
  .on("error", (error) => {
    console.log(`[E] (${mkt_name}) > New trade error:`,error);
    sendMail(
      process.env.SEND_ERROR_MAILS, 
      `${mkt_name}`,
      `[E] New trade error: ${error}`
    ).catch(console.error);
    process.exit();
  })
  .subscribe(`${base}/${quote}`);

  await kraken.ws.book({depth: 100})
  .on("mirror", ({as, bs}) => {
    current_order_book = {
      bids: bs.slice(0, 20).map(([p, q]) => [ p, q ]),
      asks: as.slice(0, 20).map(([p, q]) => [ p, q ])
    }
  })
  .on("error", (error) => {
    console.log(`[E] (${mkt_name}) > Orderbook update:`,error);
    sendMail(
      process.env.SEND_ERROR_MAILS, 
      `${mkt_name}`,
      `[E] Orderbook update: ${error}`
    ).catch(console.error);
    process.exit();
  })
  .subscribe(`${base}/${quote}`); 

  newSecTimeout = setTimeout(newSecond, (parseInt(Date.now() / 1e3) + 1) * 1e3 - Date.now());
}

function newSecond () {
  // New second.
  // console.log('novo segundo, market_synced=',market_synced);
  if (market_synced) {
    let time = Date.now();

    // Checks if it is a new day.
    let today = new Date(time - 60e3*60*3).getUTCHours();
    if (today != last_day) {
      last_day = today;
      newDay(time);
    }

    if (current_order_book && trades) {
      let obj = { orderbook: current_order_book, trades };

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
  const filename = `Kraken_${base}-${quote}_${day_str}`;

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

watchMarket("XBT", "USD");

// export default watchMarket;