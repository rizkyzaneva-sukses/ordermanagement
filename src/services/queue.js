const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});
connection.on('error', (err) => {
  // Silent catch in dev mode if Redis is offline
});

const syncQueue = new Queue('order-sync', { connection });
const printQueue = new Queue('print-batch', { connection });

module.exports = { syncQueue, printQueue, connection };
