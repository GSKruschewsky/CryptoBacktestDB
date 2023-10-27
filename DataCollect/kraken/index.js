const { Kraken } = require("node-kraken-api");
const exportToS3 = require("../../exporterApp/src/index");
const sendMail = require("../../helper/sendMail");
require('dotenv').config({ path: "../../.env" });

const kraken = new Kraken();
let trades = null;
let current_order_book = null;
let _validation_list = [];

async function watchMarket (base, quote) {
  await kraken.ws.trade()
  .on('update', ([[ price, amount, time, side ]], market)  => {
    if (trades) {
      let tradedata = { 
        market, 
        time: time * 1e3, 
        side: (side == "b" ? "buy" : "sell"), 
        amount, 
        price 
      };
      trades.push(tradedata);
    }
  })
  .on("error", (error) => {
    sendMail(
      process.env.SEND_ERROR_MAILS, 
      "Kraken", 
      `[E] New trade error: ${error}`
    ).catch(console.error);
  })
  .subscribe(`${base}/${quote}`);

  await kraken.ws.book({depth: 100})
  .on("mirror", ({as, bs}) => {
    current_order_book = {
      bids: bs.slice(0, 20),
      asks: as.slice(0, 20)
    }
  })
  .on("error", (error) => {
    sendMail(
      process.env.SEND_ERROR_MAILS, 
      "Kraken", 
      `[E] Orderbook update: ${error}`
    ).catch(console.error);
  })
  .subscribe(`${base}/${quote}`); 

  setTimeout(newSecond, (parseInt(Date.now() / 1e3) + 1) * 1e3 - Date.now());
}

function newSecond () {
  // New second.
  if (current_order_book && trades) {
    let time = Date.now();
    let time_str = new Date(time - 60e3*60*3).toISOString().split('.')[0];

    let obj = { time, orderbook: current_order_book, trades };

    _validation_list.push(JSON.stringify(obj));
    _validation_list = _validation_list.slice(-100);

    if (_validation_list.length == 100) {
      if (!_validation_list.some(json => json != _validation_list[0])) {
        sendMail(
          process.env.SEND_ERROR_MAILS, 
          "Kraken", 
          "[E] As ultimas 100 postagens foram iguais!"
        ).catch(console.error);
      }
    }
    
    // exportToS3("crypto-backtest-db", obj, `Kraken_${base}-${quote}_${time_str}`);
    console.log(obj);
  }

  trades = [];

  setTimeout(newSecond, (parseInt(Date.now() / 1e3) + 1) * 1e3 - Date.now());
}

watchMarket("XBT", "USD");

// module.exports = watchMarket;