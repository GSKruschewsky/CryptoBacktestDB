import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { JsonStreamStringify } from 'json-stream-stringify';
import zlib from 'zlib';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const client = new S3Client({
  region: process.env['AWS-S3_REGION'], 
  credentials: {
      accessKeyId: process.env['AWS-S3_ACCESS_KEY_ID'],
      secretAccessKey: process.env['AWS-S3_SECRET_ACCESS_KEY'],
  }
});

function getFromBucket (name) {
  return client.send(new GetObjectCommand({
    Bucket: process.env['AWS-S3_BUCKET_NAME'],
    Key: name,
  }));
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

const datestr = '2023-12-18T13-30';

(async () => {
  let promises = [];

  for (const quote of Object.keys(exchanges)) {
    for (const exchange of exchanges[quote]) {
      for (const base of assets) {
        if (base == quote) continue; // Avoids 'USDT-USDT'.
        if (exchange == 'mexc-spot') continue; // 18/12 Mexc not working.
        
        promises.push(getFromBucket(`${exchange}_${base}-${quote}_${datestr}.json.gz`));
      }
    }
  }

  Promise.all(promises)
  .then(r_Arr => {
    console.log('r_Arr:',r_Arr);
  })
})();