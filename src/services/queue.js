'use strict';

const { Queue } = require('bullmq');
const IORedis = require('ioredis');

/**
 * Shared ioredis connection used by BullMQ queues and workers.
 *
 * Key settings:
 *  - maxRetriesPerRequest: null  — required by BullMQ (disables per-command retry limit)
 *  - retryStrategy             — exponential back-off; give up after 10 failed attempts
 *    so a permanently unavailable Redis doesn't spin forever
 *  - enableReadyCheck: false   — skip the initial PING/PONG check so we don't block
 *    startup if Redis is momentarily slow
 */
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy(times) {
    if (times > 10) {
      console.error('[redis] Giving up after 10 reconnect attempts');
      return null; // stop retrying
    }
    const delay = Math.min(times * 200, 3000); // cap at 3 s
    console.warn(`[redis] Reconnecting in ${delay}ms (attempt ${times})`);
    return delay;
  },
});

connection.on('connect', () => console.log('[redis] Connected'));
connection.on('ready',   () => console.log('[redis] Ready'));
connection.on('error',   (err) => console.error('[redis] Error:', err?.message || err?.code || String(err)));
connection.on('close',   () => console.warn('[redis] Connection closed'));
connection.on('reconnecting', () => console.warn('[redis] Reconnecting…'));

const syncQueue  = new Queue('order-sync',   { connection });
const printQueue = new Queue('print-batch',  { connection });

module.exports = { syncQueue, printQueue, connection };

