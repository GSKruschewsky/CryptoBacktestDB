import { Kraken } from "node-kraken-api";
import exportToS3 from "../../exporterApp/src/index.js";
import sendMail from "../../helper/sendMail.js";
import dotenv from "dotenv";
dotenv.config();

const kraken = new Kraken();
let trades = null;
let current_order_book = null;
let _validation_list = [];
let base, quote, mkt_name;

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

  setTimeout(newSecond, (parseInt(Date.now() / 1e3) + 1) * 1e3 - Date.now());
}

function newSecond () {
  // New second.
  if (current_order_book && trades) {
    let time = Date.now();
    let time_str = new Date(time - 60e3*60*3).toISOString().split('.')[0];

    let obj = { orderbook: current_order_book, trades };

    _validation_list.push(JSON.stringify(obj));
    _validation_list = _validation_list.slice(-100);

    obj.time = time;

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

    const filename = `Kraken_${base}-${quote}_${time_str}`;
    exportToS3("crypto-backtest-db", obj, filename)
    .then(r => console.log(`[!] Arquivo enviado: ${filename}`))
    .catch(err => {
      console.log(`[E] ${mkt_name} > exportToS3 - Failed to upload file:`,err);
      sendMail(
        process.env.SEND_ERROR_MAILS, 
        `${mkt_name}`,
        'Bot falhou ao enviar arquivo para AWS S3!',
      ).catch(console.error);
      process.exit();
    });
    // console.log('time:',time);
    // console.log('best_ask:',obj.orderbook.asks[0]);
    // console.log('best_bid:',obj.orderbook.bids[0]);
    // console.log('trades ('+trades.length+'):',obj.trades,'\n');
  }

  trades = [];

  setTimeout(newSecond, (parseInt(Date.now() / 1e3) + 1) * 1e3 - Date.now());
}

watchMarket("XBT", "USD");

// export default watchMarket;