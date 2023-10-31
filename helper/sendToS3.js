import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import dotenv from 'dotenv';
dotenv.config();

const client = new S3Client({
    region: process.env.REGION, 
    credentials: {
        accessKeyId: process.env.ACCESS_KEY_ID,
        secretAccessKey: process.env.SECRET_ACCESS_KEY,
    }
});

async function sendToS3 (bucketName, jsonData, fileName){
    return client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: `${fileName}.json`,
        Body: Buffer.from(typeof jsonData == 'string' ? jsonData : JSON.stringify(jsonData), 'utf-8'),
        ContentType: 'application/json'
    }));
}

export default sendToS3;

// sendToS3('crypto-backtest-db', {json_example: 'certo'}, 'julesca')