import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

export default sendToS3;