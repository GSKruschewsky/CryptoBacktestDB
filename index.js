import Big from 'big.js';
import { Synchronizer } from "./Synchronizer/index.js";
import { CompressAndSendBigJSONToS3 } from "./helper/sendToS3.js";

// Get and validate parameters/arguments.
let args = process.argv.slice(2); // Get command-line arguments, starting from index 2
if (args.length !== 3 && args.length !== 4) {
  console.log("Usage: npm sync <exchange> <base> <quote> <delay_time_in_seconds (optional, default= 1)>");
  process.exit(1);
}

// 'console.log' start printng the current time (UTC-3).
const dlog = console.log;
console.log = (...args) => {
  const ts = Date.now()-60e3*60*3;
  const strtime = new Date(ts).toLocaleString('pt-BR', { timeZone: 'UTC' }).replace(',', '') + '.' + (ts%1e3+'').padStart(3, 0);
  return dlog(...[ strtime, '-', ...args ]);
}

let sync = new Synchronizer(...args);
let seconds_data = [];

function save_second (data_time, not_first) {
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

  if (orderbook_to_post) {
    seconds_data.push({
      asks: orderbook_to_post?.asks,
      bids: orderbook_to_post?.bids,
      book_timestamp: orderbook_to_post?.timestamp,
      trades: trades_to_post,
      second: data_time,
    });
  } else {
    if (not_first && sync.orderbooks.length > 0) {
      console.log('/!\\ No orderbook to save at '+data_time+'.');
      console.log('sync.orderbooks:',sync.orderbooks.map(op => op.timestamp));
      console.log('sync.orderbook:',sync.orderbook?.timestamp);
      console.log('sync.delayed_orderbook:',sync.delayed_orderbook?.timestamp);
    }
  }
}

sync.on('newSecond', async function (timestamp, data_time, not_first) {
  if ((!not_first) && sync.orderbooks.length > 0) {
    // Define 'first_book_time' and 'synced_trades_since'.
    const first_book_time = sync.orderbooks.slice(-1)[0].timestamp;
    const synced_trades_since = sync.synced_trades_since;

    // Define 'first_sec_ready_to_post'.
    let first_sec_ready_to_post = Math.ceil(Math.min(first_book_time / 1e3, synced_trades_since / 1e3 + 1));
    while (first_sec_ready_to_post < first_book_time / 1e3 || first_sec_ready_to_post < synced_trades_since / 1e3 + 1)
      ++first_sec_ready_to_post;

    // Save all seconds after 'first_sec_ready_to_post' and before the current second.
    for (let sec = first_sec_ready_to_post; sec < data_time; ++sec) save_second(sec);
  }

  // Save the current second in memory.
  save_second(data_time, not_first);

  // Check if its a new 'half-hour', if so save data to AWS S3.
  if (data_time % 1800 == 0) {
    // Create a name to the file being saved.
    const timestr = new Date(data_time - 60*60*3).toISOString().slice(0, 16).replace(':', '-');
    const name = `${sync.full_market_name.replace(' ', '_')}_${timestr}.json`;

    // Compress data then save it.
    CompressAndSendBigJSONToS3(name, seconds_data);
    
    // Reset 'seconds_data'.
    seconds_data = [];
  }
});

sync.initiate()
.catch(error => {
  console.log('Failed to initate synchronization:',error);
});