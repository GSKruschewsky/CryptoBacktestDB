import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { JsonStreamStringify } from 'json-stream-stringify';
import Big from 'big.js';
import fs from 'fs';

// Commonjs importing 
import pkg from 'node-gzip';
const { ungzip } = pkg;

import dotenv from 'dotenv';
dotenv.config();

const client = new S3Client({
  region: process.env['AWS-S3_REGION'], 
  credentials: {
      accessKeyId: process.env['AWS-S3_ACCESS_KEY_ID'],
      secretAccessKey: process.env['AWS-S3_SECRET_ACCESS_KEY'],
  }
});

async function getFromBucket (exchange, base, quote) {
  const name = `${exchange}_${base}-${quote}_${datestr}`;

  let r =  await client.send(new GetObjectCommand({
    Bucket: process.env['AWS-S3_BUCKET_NAME'],
    Key: `${name}.json.gz`,
  }));

  return { name, data: JSON.parse(await ungzip(await r.Body.transformToByteArray())) };
}

const exchanges = {
  'USDT': [
    'binance-spot',
    'kucoin-spot',
    'bybit-spot',
    'okx-spot',
    'mexc-spot',
    'htx-spot',
    'coinex-spot'
  ],
  'USD': [
    'cryptodotcom-spot',
    'coinbase-spot',
    'kraken-spot',
    'bitfinex-spot',
    'bitstamp-spot'
  ]
};

const assets = [
  'BTC',
  'ETH',
  'SOL',
  'XRP',
  'DOGE',
  'AVAX',
  'USDT'
];

const datestr = '2023-12-18T17-00';

(async () => {
  console.log('Getting "'+datestr+'" data from S3...');

  let promises = [];
  
  for (const quote of Object.keys(exchanges)) {
    for (const exchange of exchanges[quote]) {
      for (const base of assets) {
        if (base == quote) continue; // Avoids 'USDT-USDT'.
        if (exchange == 'mexc-spot') continue; // 18/12 Mexc not working.
        promises.push(getFromBucket(exchange, base, quote));
      }
    }
  }
  
  // Format, process and reduce 'data'.
  let reduced = {};
  let data = (await Promise.all(promises)).reduce((data, obj) => {
    const [ exchange, market ] = obj.name.split('_');
    if (!data[exchange]) data[exchange] = {};

    // Create the current exchange and market on 'reduced'.
    if (!reduced[exchange]) reduced[exchange] = {};
    if (!reduced[exchange][market]) reduced[exchange][market] = [];

    for (let second_data of obj.data) {
      const { asks, bids, book_timestamp, second } = second_data;

      // Define 'mid_price'.
      second_data.mid_price = Big(asks[0][0]).plus(bids[0][0]).div(2).toFixed(8);

      // Define 'imb_mid_price'.
      const imb_mid = Big(bids[0][1]).div(Big(bids[0][1]).plus(Big(asks[0][1])));
      second_data.imb_mid_price = Big(1).minus(imb_mid).times(bids[0][0]).plus(imb_mid.times(asks[0][0])).toFixed(8);

      // Define 'book_imb.max'.
      let book_imb = { asks: {}, bids:{}, max: 100e3 };

      for (const side of [ 'asks', 'bids' ]) {
        const book_side = second_data[side];

        let restante = Big(book_imb.max);
        let executed = Big(0);
        for (let i = 0; i < book_side.length && restante.gt(0); ++i) {
          const pl = book_side[i];
          const pl_value = Big(pl[0]).times(pl[1]);

          if (pl_value.gt(restante)) {
            executed = executed.plus(restante.div(pl[0]));
            restante = Big(0);
          } else {
            restante = restante.minus(pl_value);
            executed = executed.plus(pl[1]);
          }
        }
        book_imb[side].value = Big(book_imb.max).minus(restante);
        book_imb[side].price = Big(book_imb[side].value).div(executed);
      }

      // Equalize 'book_imb.asks.value' and 'book_imb.bids.value', if necessary.
      if (!book_imb.asks.value.eq(book_imb.bids.value)) {
        let lower_side = book_imb.asks.value.gt(book_imb.bids.value) ? 'bids' : 'asks';
        let higher_side = lower_side == 'asks' ? 'bids' : 'asks';

        let restante = Big(book_imb[lower_side].value);
        let executed = Big(0);
        
        const book_side = second_data[higher_side];
        for (let i = 0; i < book_side.length && restante.gt(0); ++i) {
          const pl = book_side[i];
          const pl_value = Big(pl[0]).times(pl[1]);

          if (pl_value.gt(restante)) {
            executed = executed.plus(restante.div(pl[0]));
            restante = Big(0);
          } else {
            restante = restante.minus(pl_value);
            executed = executed.plus(pl[1]);
          }
        }
        book_imb[higher_side].value = Big(book_imb[lower_side].value).minus(restante);
        book_imb[higher_side].price = Big(book_imb[higher_side].value).div(executed);
      }
      
      // Define 'book_imb_value' and 'book_imb_value'.
      second_data.book_imb_value = book_imb.asks.value.toFixed(2);
      second_data.book_imb_price = book_imb.asks.price.plus(book_imb.bids.price).div(2).toFixed(8);

      // Push only essential data to 'reduced'.
      reduced[exchange][market].push({
        mid_price: second_data.mid_price,
        imb_mid_price: second_data.imb_mid_price,
        book_imb_value: second_data.book_imb_value,
        book_imb_price: second_data.book_imb_price,
        book_timestamp, 
        second
      });
    }

    data[exchange][market] = obj.data;
    return data;
  }, {});

  const filename = 'reduced_'+datestr+'.json';
  fs.writeFileSync(filename, JSON.stringify(reduced));

  console.log('[!] "'+filename+'" successfuly saved.');

})();