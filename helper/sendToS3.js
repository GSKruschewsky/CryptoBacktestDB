// Import AWS S3 Commands
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from '@aws-sdk/lib-storage';
import { JsonStreamStringify } from 'json-stream-stringify';
import zlib from 'zlib';
import dotenv from 'dotenv';
dotenv.config();

const client = new S3Client({
    region: process.env['AWS-S3_REGION'], 
    credentials: {
        accessKeyId: process.env['AWS-S3_ACCESS_KEY_ID'],
        secretAccessKey: process.env['AWS-S3_SECRET_ACCESS_KEY'],
    }
});

async function CompressAndSendBigJSONToS3 (name, bigjson) {
    const compress_stream = zlib.createGzip();
    new JsonStreamStringify(bigjson).pipe(compress_stream);

    const upload = new Upload({
        client,
        params: {
            Bucket: process.env['AWS-S3_BUCKET_NAME'],
            Key: name+'.gz',
            Body: compress_stream,
        }
    });

    await upload.done();
}

export { CompressAndSendBigJSONToS3 };