const { Kraken } = require("node-kraken-api");
const exportToS3 = require("../../exporterApp/src/index");

const kraken = new Kraken();
let trades = null;
let current_order_book = null;

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
    console.log("[E] New trade error:",error);
    process.exit();
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
    console.log("[E] Orderbook update:",error);
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
    // exportToS3("crypto-backtest-db", { time, orderbook: current_order_book, trades }, `Kraken_${base}-${quote}_${time_str}`);
    console.log({ time, orderbook: current_order_book, trades });
  }

  trades = [];

  setTimeout(newSecond, (parseInt(Date.now() / 1e3) + 1) * 1e3 - Date.now());
}

watchMarket("XBT", "USD");

// module.exports = watchMarket;