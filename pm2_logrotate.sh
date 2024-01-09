find ~/.pm2/logs/* -name '*.log' -exec sh ./logrotate.sh {} 1000000 \;
sh ./logrotate.sh ~/.pm2/pm2.log 1000000