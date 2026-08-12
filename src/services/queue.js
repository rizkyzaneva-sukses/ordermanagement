'use strict';

const { Queue } = require('bullmq');
const IORedis = require('ioredis');

/**
 * Shared ioredis connection used by BullMQ queues and workers.
 *
 * Key settings:
 *  - maxRetriesPerRequest: null  — required by BullMQ
 *  - lazyConnect: true           — don't connect immediately on require()
 *  - retryStrategy              — reconnect indefinitely (see below)
 *  - enableReadyCheck: false    — skip initial PING/PONG
 */
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  /**
   * Retry forever, with the delay growing to a 3 s ceiling.
   *
   * This used to stop after 10 attempts — 12 seconds in total — leaving the
   * connection in ioredis' "end" state, which nothing here ever revives. On a
   * redeploy the worker and Redis restart together and Redis routinely takes
   * longer than that to become resolvable, so the worker gave up before it ever
   * connected: it then sat idle forever consuming no jobs, while looking healthy
   * enough (no crash, no restart) that the outage was invisible. Automatic sync
   * simply stopped until someone noticed the data going stale.
   *
   * A worker that reconnects on its own is strictly better here — the queue is
   * durable, so jobs published during the outage are still waiting.
   */
  retryStrategy(times) {
    const delay = Math.min(times * 200, 3000);
    // Past the first few attempts this is a sustained outage rather than a
    // blip, and a line every 3 s buries everything else in the log.
    if (times <= 5 || times % 20 === 0) {
      console.warn(`[redis] Reconnecting in ${delay}ms (attempt ${times})`);
    }
    return delay;
  },
});

/**
 * Log the first few events of an outage, then only every 20th.
 *
 * Each failed attempt fires `error` and `close`, so now that retries never stop
 * an unreachable Redis would otherwise print several lines every 3 seconds for
 * as long as it is down — which is precisely how the last outage buried the
 * Shopee sync errors that were worth reading. Reset once Redis is back, so the
 * next outage gets a full-volume opening again.
 */
let outageEvents = 0;
const logOutage = (line) => {
  outageEvents += 1;
  if (outageEvents <= 5 || outageEvents % 20 === 0) console.warn(line);
};

connection.on('connect', () => console.log('[redis] Connected'));
connection.on('ready',   () => { outageEvents = 0; console.log('[redis] Ready'); });

// An ioredis connection with no 'error' listener takes the process down, so this
// stays registered no matter how quiet it gets.
connection.on('error', (err) => logOutage(`[redis] Error: ${err?.message || err?.code || String(err)}`));
connection.on('close', () => logOutage('[redis] Connection closed'));
// Reached only on an explicit quit/disconnect now that retries never stop
connection.on('end', () => {
  console.error('[redis] Connection ended');
});

// ── Graceful handling of unhandled Redis errors ─────────────────────────────
// When ioredis cannot reach Redis and BullMQ still tries to issue a command, it
// throws an AggregateError / Error that would crash the process.
// We surface it as a logged error instead.
//
// ENOTFOUND/EAI_AGAIN belong here too: an unresolvable hostname is what a
// restarting Redis looks like from a container that came up first, and the
// connection now retries through it rather than dying.
const TRANSIENT_REDIS_ERRORS = [
  'ECONNREFUSED',
  'Connection is closed',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
];

process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason?.code || reason);
  if (TRANSIENT_REDIS_ERRORS.some(code => msg.includes(code))) {
    // Throttled with the rest of the outage — one rejection per failed command
    logOutage(`[redis] Unhandled Redis rejection (server unavailable): ${msg}`);
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
