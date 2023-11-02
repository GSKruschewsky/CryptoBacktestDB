// import { version, exchanges } from 'ccxt';
// console.log(version, Object.keys(exchanges));

import { pro as ccxt } from 'ccxt';
const { log } = console;

(async () => {
  const [ _exchange, base, quote ] = process.argv.slice(2);
  const exchange = _exchange.toLowerCase();
  const market = (`${base}/${quote}`).toUpperCase();

  try {
    if (!ccxt.exchanges.includes(exchange))
      throw new Error('Invalid exchange.', 400);

    const exc = new ccxt[exchange]({ newUpdates: true });
    
    if (!exc.has.ws)
      throw new Error('Exchange implementation do not support websocket.', 500);

    if (!exc.has.watchTrades)
      throw new Error('Exchange implementation do not support trades synchronization.', 500);

    if (!exc.has.watchOrderBook)
      throw new Error('Exchange implementation do not support orderbook synchronization.', 500);

    const markets = await exc.loadMarkets();

    if (!markets[market])
      throw new Error('Invalid market.', 400);

    const market_info = markets[market];

    if (!market_info.active)
      throw new Error('Market is not active.', 500);

    // // Sync with the orderbook.
    // const orderbook = await exc.watchOrderBook(market, 25);
    // setInterval(() => {
    //   console.log('orderbook:',orderbook);
    // }, 1e3);

    // Sync with trades
    let trades = null, tradesLoopTimeout;
    const tradesLoop = async () => {
      const now = Date.now();
      const ms = now % 1000;

      tradesLoopTimeout = setTimeout(tradesLoop, 1000 - ms);
      
      trades = await exc.watchTrades(market, now - ms);
      console.log(`${now} - (${trades.length}) trades.`);
    };
    tradesLoopTimeout = setTimeout(tradesLoop, 1000 - Date.now() % 1000);

  } catch (err) {
    log('[E] Starting data collector:',err);
  }
})();

