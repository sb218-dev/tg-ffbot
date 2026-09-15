module.exports = {
  apps: [
    {
      name: 'tg-fastfood',
      script: 'server.js',
      cwd: __dirname,
      autorestart: true,
      watch: false,
      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 5000,             // 5 секунд задержки перед рестартом (ждём сеть/прокси при перезагрузке ОС)
      exp_backoff_restart_delay: 2000,  // Экспоненциальное увеличение паузы при частых сбоях
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
