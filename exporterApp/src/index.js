const AWS = require('aws-sdk');
require('dotenv').config({path: '../../.env'});

function exportToS3(bucketName, jsonData, fileName){
    AWS.config.update({
        accessKeyId: process.env.ACCESS_KEY_ID,
        secretAccessKey: process.env.SECRET_ACCESS_KEY,
        region: process.env.REGION
    });
    
    const s3 = new AWS.S3();
    
    const params = {
        Bucket: bucketName,
        Key: `${fileName}.json`,
        Body: Buffer.from(JSON.stringify(jsonData), 'utf-8'),
        ContentType: 'application/json'
    };
    
    s3.upload(params, (err, data) => {
        if (err) {
            console.error('Erro ao fazer o upload:', err);
        } else {
            console.log('Arquivo enviado com sucesso para:', data.Location);
        }
    });
}

module.exports = exportToS3;

// exportToS3('crypto-backtest-db', {json_example: 'certo'}, 'julesca')