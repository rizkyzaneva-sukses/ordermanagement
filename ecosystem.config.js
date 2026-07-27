module.exports = {
  apps: [
    {
      name: 'orderpro-api',
      script: 'src/server.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
      merge_logs: true,
      // Restart policy
      max_memory_restart: '512M',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      // Watch (dev only)
      watch: false,
      ignore_watch: ['node_modules', 'logs', 'storage', '.git'],
    },
    {
      name: 'orderpro-worker',
      script: 'src/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/worker-error.log',
      out_file: './logs/worker-out.log',
      merge_logs: true,
      // Restart policy
      max_memory_restart: '256M',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      // Cron restart (daily at 3 AM)
      cron_restart: '0 3 * * *',
      // Watch (dev only)
      watch: false,
    },
  ],

  // Deployment configuration
  deploy: {
    production: {
      user: 'deploy',
      host: ['your-server-ip'],
      ref: 'origin/main',
      repo: 'git@github.com:your-org/orderpro.git',
      path: '/var/www/orderpro',
      'pre-deploy-local': 'echo "Starting deployment..."',
      'post-deploy': 'npm install && npx prisma generate && npx prisma migrate deploy && pm2 reload ecosystem.config.js --env production',
      'pre-setup': 'echo "Setting up server..."',
      env: {
        NODE_ENV: 'production',
      },
    },
  },
};
