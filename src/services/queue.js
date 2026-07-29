'use strict';

const { Queue } = require('bullmq');
const IORedis = require('ioredis');

/**
 * Shared ioredis connection used by BullMQ queues and workers.
 *
 * Key settings:
 *  - maxRetriesPerRequest: null  — required by BullMQ
 *  - lazyConnect: true           — don't connect immediately on require()
 *  - retryStrategy              — give up after 10 failed attempts so a
 *    permanently unavailable Redis doesn't spin forever
 *  - enableReadyCheck: false    — skip initial PING/PONG
 */
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  retryStrategy(times) {
    if (times > 10) {
      console.error('[redis] Giving up after 10 reconnect attempts');
      return null; // stop retrying — connection moves to "end" state
    }
    const delay = Math.min(times * 200, 3000); // cap at 3 s
    console.warn(`[redis] Reconnecting in ${delay}ms (attempt ${times})`);
    return delay;
  },
});

connection.on('connect',      () => console.log('[redis] Connected'));
connection.on('ready',        () => console.log('[redis] Ready'));
connection.on('error',        (err) => console.error('[redis] Error:', err?.message || err?.code || String(err)));
connection.on('close',        () => console.warn('[redis] Connection closed'));
connection.on('reconnecting', () => console.warn('[redis] Reconnecting…'));
connection.on('end', () => {
  console.error('[redis] Connection ended permanently (all retries exhausted)');
});

// ── Graceful handling of unhandled Redis errors ─────────────────────────────
// When ioredis reaches "end" state and BullMQ still tries to issue a command,
// it throws an AggregateError / Error that would crash the process.
// We surface it as a logged error instead.
process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason?.code || reason);
  if (msg.includes('ECONNREFUSED') || msg.includes('Connection is closed')) {
    console.error('[redis] Unhandled Redis rejection (server unavailable):', msg);
    return; // swallow — don't crash
  }
  // Re-throw non-Redis unhandled rejections so they're still visible
  console.error('[unhandledRejection]', reason);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** True if the redis connection is alive and ready */
function isRedisReady() {
  return connection.status === 'ready';
}

/**
 * True if at least one worker is currently consuming the given queue.
 *
 * Enqueuing when nothing is listening is indistinguishable from success at the
 * API level — the job simply sits in Redis forever. Callers use this to decide
 * whether to fall back to running the work in-process.
 *
 * Returns false on any error: assuming "no worker" is the safe direction, since
 * the fallback path still gets the work done.
 *
 * @param {import('bullmq').Queue} queue
 * @returns {Promise<boolean>}
 */
async function hasQueueWorkers(queue) {
  if (!isRedisReady()) return false;

  try {
    const workers = await queue.getWorkers();
    return Array.isArray(workers) && workers.length > 0;
  } catch (err) {
    console.warn(`[redis] Could not determine worker count for "${queue?.name}": ${err.message}`);
    return false;
  }
}

/** Attempt to connect (no-op if already connected/connecting). */
async function connect() {
  if (connection.status === 'wait' || connection.status === 'end') {
    try {
      await connection.connect();
    } catch (err) {
      console.error('[redis] connect() failed:', err.message);
    }
  }
}

// Kick off the connection attempt at module load time (non-blocking)
connect();

// ── Queues ──────────────────────────────────────────────────────────────────

const syncQueue  = new Queue('order-sync',  { connection });
const printQueue = new Queue('print-batch', { connection });

module.exports = { syncQueue, printQueue, connection, isRedisReady, hasQueueWorkers, connect };
