const nodemailer = require("nodemailer");
require('dotenv').config({ path: "../.env" });

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.PORT,
  secure: true,
  auth: {
    user: process.env.USER,
    pass: process.env.PASS,
  },
});

async function sendMail(mailTo, exchange, message) {
  const info = await transporter.sendMail({
    from: '"CryptoBacktestDB 👻" <adm@codiegos.com>',
    to: mailTo,
    subject: `Erro 𝕏 - ${exchange}`, 
    text: `Ocorreu um erro com o bot da exchange ${exchange}. \nMensagem: ${message}`, 
    html: `<b>Ocorreu um erro com o bot ${exchange}. <br>Mensagem: ${message}</b>`,
  });

  console.log(`Message sent: ${info.messageId}`);
}

module.exports = sendMail