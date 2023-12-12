import Big from 'big.js';
import fs from 'fs';
import { Synchronizer, exchanges } from "./Synchronizer/index.js";

let args = process.argv.slice(2);

if (args[0] == 'us') {
  delete exchanges['binance-spot'];
  delete exchanges['bybit-spot'];
}

const min_latencies = 10;

function calcMean (arr) {
  const mid_arr = Math.floor(arr.length / 2);
  let mean = Big(arr[mid_arr]);

  if (arr.length % 2 == 0) {
    mean = mean.plus(arr[mid_arr - 1]);
    mean = mean.div(2);
  }

  return mean.toFixed(3);
}

async function calcLatency (sync) {
  sync.silent_mode = true;
  while (Math.min(sync.conn_latency.length, sync.subr_latency.length, sync.diff_latency.length) < min_latencies) {
    await sync.initiate() // Initiate exchange synchronization.
    .catch(err => {
      console.log(sync.exchange,'error:',err);
      process.exit();
    });
    await new Promise(r => setTimeout(r, 10e3)); // Then, waits 10 seconds...
    sync.end(); // Then, ends synchronization...
  }
  
  sync.conn_latency.sort();
  sync.subr_latency.sort();
  sync.diff_latency.sort();

  // Format and return latency results.
  return [ 'conn_latency', 'subr_latency', 'diff_latency' ]
  .reduce((obj, type) => {
    obj[type] = {
      length: sync[type].length,
      lowest: sync[type][0],
      avg: sync[type].every(l => l != undefined) ? sync[type].reduce((s, l) => Big(s).plus(l), Big(0)).div(sync[type].length).toFixed(3) : undefined,
      mean: sync[type].every(l => l != undefined) ? calcMean(sync[type]) : undefined,
      highest: sync[type].slice(-1)[0]
    }
    return obj;
  }, { exchange: sync.exchange });
}

console.log('Running latency test...\n(This test may take some minutes to complete)\n');
Promise.all(Object.keys(exchanges).map(exchange => {
  const [ base, quote ] = exchanges[exchange]["latency-test-symbol"].split('/');
  const sync = new Synchronizer(exchange, base, quote);
  return calcLatency(sync);
}))
.then(results => {
  results.sort((a, b) => Big(a.conn_latency.mean).cmp(b.conn_latency.mean));

  let txt = "";
  for (const r of results) {
    txt += r.exchange+':\n'+
    'conn_latency  mean= '+r.conn_latency.mean+'ms  avg= '+r.conn_latency.avg+'ms  lowest= '+r.conn_latency.lowest+'ms  highest= '+r.conn_latency.highest+'ms  ('+r.conn_latency.length+')\n'+
    'subr_latency  mean= '+r.subr_latency.mean+'ms  avg= '+r.subr_latency.avg+'ms  lowest= '+r.subr_latency.lowest+'ms  highest= '+r.subr_latency.highest+'ms  ('+r.subr_latency.length+')\n'+
    'diff_latency  mean= '+r.diff_latency.mean+'ms  avg= '+r.diff_latency.avg+'ms  lowest= '+r.diff_latency.lowest+'ms  highest= '+r.diff_latency.highest+'ms  ('+r.diff_latency.length+')\n \n';
  }

  const strtime = new Date(Date.now()-60e3*60*3).toLocaleString('pt-BR', { timeZone: 'UTC' }).replace(',', '').replace(' ', '_').replaceAll('/', '-').replaceAll(':', '-');
  fs.writeFileSync('latency-test_'+strtime+'.txt', txt);

  console.log('Latency test result:\n'+txt);
  process.exit();
})
.catch(err => {
  console.log('Failed to get latencies from all exchnages:',err);
  process.exit();
});
