import Big from 'big.js';
import fs from 'fs';
import Synchronizer from "./Synchronizer/index.js";
import exchanges from './Synchronizer/Exchanges/index.js';

let args = process.argv.slice(2);

if (args[0] == 'us') {
  delete exchanges['binance-spot'];
  delete exchanges['bybit-spot'];
}

const min_latencies = 100;

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
  sync.is_test = true;
  sync.silent_mode = true;
  sync.is_lantecy_test = true;
  while (Math.min(sync.conn_latency.length, sync.subr_latency.length, sync.diff_latency.length) < min_latencies) {
    try {
      await sync.initiate(); // Initiate exchange synchronization.
      await new Promise(r => setTimeout(r, 900e3)); // Then, waits 900 seconds...

    } catch (error) {
      console.log(sync.exchange,'error:',error);
    }

    // console.log(sync.exchange+':',
    //   '\n\tsync.conn_latency.length:',sync.conn_latency.length,
    //   '\n\tsync.subr_latency.length:',sync.subr_latency.length,
    //   '\n\tsync.diff_latency.length:',sync.diff_latency.length,
    // '\n');

    sync.end(); // Then, ends synchronization...
  }
  
  await new Promise(r => setTimeout(r, 1e3)); // Just in case...

  // Sort latency arrays
  sync.conn_latency.sort((a, b) => Big(a).cmp(b));
  sync.subr_latency.sort((a, b) => Big(a).cmp(b));
  sync.diff_latency.sort((a, b) => Big(a).cmp(b));

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

console.dlog = console.log;

console.log('Running latency test...\n(This test may take some minutes to complete)\n');
Promise.all(Object.keys(exchanges).map(exchange => {
  console.log('Testing latency for "'+exchange+'"...');
  const [ base, quote ] = exchanges[exchange]["latency-test-symbol"].split('/');
  const sync = new Synchronizer(exchange, base, quote);
  return calcLatency(sync);
  console.log('[!] Got latency results for "'+exchange+'".');
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
