import Synchronizer from "./Synchronizer/index.js";

// Get and validate parameters/arguments.
let args = process.argv.slice(2); // Get command-line arguments, starting from index 2

let is_test = (args[0].toLowerCase() == 'test');
if (is_test) args = args.slice(1);

if (args.length !== 3 && args.length !== 4) {
  console.log("Usage: npm sync <exchange> <base> <quote> <delay_time_in_seconds (optional, default= 1)>");
  process.exit(1);
}

// 'console.log' start printing the current time (UTC-3).
const dlog = console.log;
console.log = (...args) => {
  const ts = Date.now()-60e3*60*3;
  const strtime = new Date(ts).toLocaleString('pt-BR', { timeZone: 'UTC' }).replace(',', '') + '.' + (ts%1e3+'').padStart(3, 0);
  return dlog(...[ strtime, '-', ...args ]);
}

let sync = new Synchronizer(...args);

if (is_test) {
  sync.is_test = true;
  sync.orderbook_depth = 5;
}

sync.keep_synced()
.catch(error => {
  console.log('Failed to keep synchronization:',error);
})
.finally(() => {
  console.log('[E] "sync.keep_synced()" finally.');
});

// Do not end...
(async () => {
  while (true) {
    await new Promise(r => setTimeout(r, 5e3));
  }
})();