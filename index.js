import Big from 'big.js';
import { Synchronizer } from "./Synchronizer/index.js";

let args = process.argv.slice(2); // Get command-line arguments, starting from index 2

if (args.length !== 3 && args.length !== 4) {
  console.log("Usage: npm sync <exchange> <base> <quote> <delay_time_in_seconds (optional, default= 1)>");
  process.exit(1);
}

let sync = new Synchronizer(...args);

sync.on('newSecond', function (timestamp, data_time, not_first) {
  // Log post data
  const trades_to_post = sync.trades
    .filter(t => 
      Big(t.timestamp).gt((data_time - 1) * 1e3) &&
      Big(t.timestamp).lte(data_time * 1e3)
    )
    .map(t => {
      delete t.trade_id;
      delete t.custom_id;
      return t;
    });

  const orderbook_to_post = sync.orderbooks.find(ob => Big(ob.timestamp).lte(data_time * 1e3));

  // if (orderbook_to_post) {
    
  console.log('First 5 orderbooks saved:',sync.orderbooks.slice(-5).map(ob => ob.timestamp),'\n');
  console.log({
    asks: orderbook_to_post?.asks?.slice(0, 5),
    bids: orderbook_to_post?.bids?.slice(0, 5),
    book_timestamp: orderbook_to_post?.timestamp,
    trades: trades_to_post,
    second: data_time,
    timestamp
  });
  // }

  /* // Start delay test
  if (sync.orderbooks.length > 0) {
    const first_book_time = sync.orderbooks.slice(-1)[0].timestamp;
    const synced_trades_since = sync.synced_trades_since;

    let first_sec_ready_to_post = Math.ceil(Math.min(first_book_time / 1e3, synced_trades_since / 1e3 + 1));
    while (first_sec_ready_to_post < first_book_time / 1e3 || first_sec_ready_to_post < synced_trades_since / 1e3 + 1)
      ++first_sec_ready_to_post;

    console.log('Started sync at:',started_at,'\n');

    console.log('First 5 orderbooks saved:',sync.orderbooks.slice(-5).map(ob => ob.timestamp),'\n');

    console.log('First orderbook:',first_book_time);
    console.log('Synced trades since:',synced_trades_since,'\n');

    console.log('First sec to post:',first_sec_ready_to_post,'\n');

    console.log('Took:',(first_sec_ready_to_post * 1e3 - started_at)+'ms','\n');
    
    process.exit();
  }
  */
});

let started_at = Date.now();

sync.initiate()
.catch(error => {
  console.log('Error:',error);
  process.exit();
});