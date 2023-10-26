const { Kraken } = require("node-kraken-api");
const exportToS3 = require("../../exporterApp/src/index");

async function getMarketData(){
    const base = "XBT";
    const quote = "USD";
    const kraken = new Kraken();
    let trades = [];
    let current_order_book = null;

    const trade = await kraken.ws.trade()
        .on('update', ([[ price, amount, time, side ]], market)  => {
            let tradedata = { 
                market, 
                time, 
                side: (side == "b" ? "buy" : "sell"), 
                amount, 
                price 
            }
            trades.push(tradedata)
        })
        .on("error", error => console.error(error))
        .subscribe(`${base}/${quote}`)

    const book100 = await kraken.ws.book({depth: 100})
      .on("mirror", ({as, bs}, pair) => {
        current_order_book = {
            bids: bs.slice(0, 20),
            asks: as.slice(0, 20)
        }
      })
      .on("error", error => console.error(error))
      .subscribe(`${base}/${quote}`); 

      setInterval(() => {
        let time = Date.now();
        let time_str = new Date(time - 60e3*60*3).toISOString().split('.')[0];
        exportToS3("crypto-backtest-db", { time, current_order_book, trades }, `Kraken_${time_str}`);
        trades = [];
        current_order_book = []
      }, 1000);
}

getMarketData()