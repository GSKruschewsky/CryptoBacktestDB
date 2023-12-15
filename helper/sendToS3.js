// Import AWS S3 Commands
import { 
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    PutObjectCommand, 
    S3Client 
} from "@aws-sdk/client-s3";
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

async function sendToS3 (name, data) {
    return client.send(new PutObjectCommand({
        Bucket: process.env['AWS-S3_BUCKET_NAME'],
        Key: name,
        Body: data
    }));
}

async function sendMultipartToS3 (name, buffer) {
    let uploadId = null;

    try {
        let multipartUpload = await client.send(new CreateMultipartUploadCommand({
            Bucket: process.env['AWS-S3_BUCKET_NAME'],
            Key: name,
        }));
        uploadId = multipartUpload.UploadId;

        let uploadPromises = [];

        // Multipart uploads require a minimum size of 5 MB per part.
        const partSize = Math.ceil(buffer.length / 5);

        // Upload each part.
        for (let i = 0; i < 5; i++) {
            const start = i * partSize;
            const end = start + partSize;
            
            const prom = client.send(new UploadPartCommand({
                Bucket: process.env['AWS-S3_BUCKET_NAME'],
                Key: name,
                UploadId: uploadId,
                Body: buffer.subarray(start, end),
                PartNumber: i + 1
            }));
            uploadPromises.push(prom);
        }

        const uploadResults = await Promise.all(uploadPromises);

        return await client.send(new CompleteMultipartUploadCommand({
            Bucket: process.env['AWS-S3_BUCKET_NAME'],
            Key: name,
            UploadId: uploadId,
            MultipartUpload: {
            Parts: uploadResults.map(({ ETag }, i) => ({
                ETag,
                PartNumber: i + 1,
            })),
            },
        }));

    } catch (err) {
        console.error(err);

        if (uploadId) {
            await client.send(new AbortMultipartUploadCommand({
                Bucket: process.env['AWS-S3_BUCKET_NAME'],
                Key: name,
                UploadId: uploadId,
            }));
        }

        throw err;
    }
}

function gzipBigJson (bigJson) {
    return new Promise((resolve, reject) => {
        let compressed_data = Buffer.alloc(0);
        const stream = new JsonStreamStringify(bigJson, null, null, false, 1048576);
        stream.on('data', chunk => {
            const compressed_chunk = zlib.gzipSync(chunk);
            compressed_data = Buffer.concat([ compressed_data, compressed_chunk ]);
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(compressed_data));
    });
}

async function SendCompressedDataToS3 (name, buffer) {
    if (buffer.length >= 104857600) {
        // Arquivo maior de 100MB, faz o upload em partes.
        return sendMultipartToS3(name, buffer);

    } else {
        // Arquivo menor de 100MB, faz o upload direto.
        return sendToS3(name, buffer);
    }
}

async function CompressAndSendBigJSONToS3 (name, bigJson) {
    let buffer = await gzipBigJson(bigJson);
    return SendCompressedDataToS3(name+'.gz', buffer);
}

export { CompressAndSendBigJSONToS3, SendCompressedDataToS3 };