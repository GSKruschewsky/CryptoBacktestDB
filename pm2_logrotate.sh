find ~/.pm2/logs/* -name '*.log' -exec sh ~/CryptoBacktestDB/rotatelog.sh {} 1000000 \;
sh ~/CryptoBacktestDB/rotatelog.sh ~/.pm2/pm2.log 1000000