'use strict';

/**
 * Scheduler — BullMQ repeatable sync jobs
 *
 * On server startup, registers a repeatable BullMQ job for every active store
 * so orders are synced automatically every SYNC_INTERVAL_MS milliseconds
 * (default: 15 minutes) without any user clicking "Sync".
 *
 * Public API:
 *   scheduler.start()          — call once at startup
 *   scheduler.addStore(id)     — call when a new store is connected / activated
 *   scheduler.removeStore(id)  — call when a store is deactivated / deleted
 */

const prisma = require('../prisma/client.js');
const { syncQueue, connection, isRedisReady } = require('./queue.js');
const fulfillmentService = require('./fulfillment.js');

// ── Configuration ─────────────────────────────────────────────────────────────

/** How often to sync each store (ms). 15 minutes default. */
const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS || '', 10) || 15 * 60 * 1000;

/** BullMQ job options shared by all repeatable sync jobs */
function repeatableJobOpts(storeId) {
  return {
    jobId: `auto-sync-${storeId}`,      // stable ID so we can remove it later
    repeat: { every: SYNC_INTERVAL_MS },
    removeOnComplete: { count: 10 },     // keep only last 10 completed jobs per store
    removeOnFail: { count: 20 },
  };
}

// ── Redis readiness helper ────────────────────────────────────────────────────

/**
 * Wait until ioredis is in 'ready' state before attempting any queue operations.
 * Times out after `timeoutMs` and resolves (not rejects) so the scheduler can
 * continue without crashing the process.
 *
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<boolean>} true if ready, false if timed out
 */
function waitForRedis(timeoutMs = 10_000) {
  return new Promise((resolve) => {
    // Already connected
    if (connection.status === 'ready') {
      return resolve(true);
    }

    const timer = setTimeout(() => {
      console.warn('[scheduler] Redis not ready after timeout — skipping job registration');
      resolve(false);
    }, timeoutMs);

    connection.once('ready', () => {
      clearTimeout(timer);
      resolve(true);
    });

    // Also handle the case where connection fails permanently
    connection.once('error', () => {
      // Don't reject — just let the timeout handle it
    });
  });
}

// ── Core helpers ──────────────────────────────────────────────────────────────

/**
 * Register (or re-register) a repeatable sync job for a single store.
 * Safe to call multiple times — BullMQ deduplicates by jobId.
 *
 * @param {string} storeId
 */
async function addStore(storeId) {
  if (!isRedisReady()) {
    console.warn(`[scheduler] Redis not available — skipping job registration for store ${storeId}`);
    return;
  }
  await syncQueue.add(
    'sync-store',
    { storeId },
    repeatableJobOpts(storeId),
  );
  console.log(`[scheduler] Repeatable sync registered for store ${storeId} (every ${SYNC_INTERVAL_MS / 60_000} min)`);
}

/**
 * Remove the repeatable sync job for a store (e.g. when deactivated).
 *
 * @param {string} storeId
 */
async function removeStore(storeId) {
  if (!isRedisReady()) {
    console.warn(`[scheduler] Redis not available — cannot remove job for store ${storeId}`);
    return;
  }
  try {
    await syncQueue.removeRepeatable('sync-store', { every: SYNC_INTERVAL_MS }, `auto-sync-${storeId}`);
    console.log(`[scheduler] Repeatable sync removed for store ${storeId}`);
  } catch (err) {
    console.warn(`[scheduler] Could not remove repeatable job for store ${storeId}:`, err.message);
  }
}

// ── AWB housekeeping ──────────────────────────────────────────────────────────

const AWB_RETENTION_DAYS  = parseInt(process.env.AWB_RETENTION_DAYS, 10) || 30;
const AWB_CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000;

let awbCleanupTimer = null;

/**
 * Periodically delete downloaded air waybills past the retention window.
 *
 * Deliberately not a BullMQ job: this is local disk housekeeping for the
 * process that wrote the files, and it must keep working when Redis is down.
 */
function startAwbCleanup() {
  if (awbCleanupTimer) return;

  const run = async () => {
    try {
      await fulfillmentService.cleanupOldAwbFiles(AWB_RETENTION_DAYS);
    } catch (err) {
      console.error('[scheduler] AWB cleanup failed:', err.message);
    }
  };

  run();
  awbCleanupTimer = setInterval(run, AWB_CLEANUP_EVERY_MS);
  // Do not hold the process open just for housekeeping
  if (typeof awbCleanupTimer.unref === 'function') awbCleanupTimer.unref();

  console.log(`[scheduler] AWB cleanup scheduled daily (retention: ${AWB_RETENTION_DAYS} days)`);
}

/** Stop the housekeeping timer (used by tests and graceful shutdown). */
function stopAwbCleanup() {
  if (awbCleanupTimer) {
    clearInterval(awbCleanupTimer);
    awbCleanupTimer = null;
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

/**
 * Bootstrap: register repeatable jobs for all currently active stores.
 * Call this once after the server starts.
 */
async function start() {
  console.log(`[scheduler] Starting — sync interval: ${SYNC_INTERVAL_MS / 60_000} min`);

  // Housekeeping runs on a plain timer, before the Redis gate below: disk fills
  // up whether or not the queue is available.
  startAwbCleanup();

  // Wait for Redis to be ready before registering jobs
  const isReady = await waitForRedis(10_000);
  if (!isReady) {
    console.error('[scheduler] Aborted: Redis not available. Auto-sync will not run until server restarts.');
    return;
  }

  let stores;
  try {
    stores = await prisma.store.findMany({
      where: { isActive: true },
      select: { id: true, name: true, platform: true },
    });
  } catch (err) {
    console.error('[scheduler] Failed to load active stores from DB:', err.message);
    return;
  }

  if (stores.length === 0) {
    console.log('[scheduler] No active stores found — no repeatable jobs registered');
    return;
  }

  console.log(`[scheduler] Registering repeatable sync for ${stores.length} active store(s)…`);
  for (const store of stores) {
    try {
      await addStore(store.id);
    } catch (err) {
      console.error(`[scheduler] Failed to register sync for store ${store.id} (${store.name}):`, err.message);
    }
  }

  console.log('[scheduler] All repeatable sync jobs registered');

  warnIfNoWorker();
}

/**
 * Warn loudly when repeatable sync jobs are being queued with nothing consuming them.
 *
 * This is the failure mode where the API is started on its own (`npm start`)
 * without `npm run worker`: every scheduled sync is accepted and silently
 * accumulates in Redis, and the UI just shows no orders.
 *
 * Checked after a delay so a worker that is still booting is not misreported.
 */
function warnIfNoWorker() {
  const CHECK_DELAY_MS = 30_000;

  const timer = setTimeout(async () => {
    try {
      const workers = await syncQueue.getWorkers();
      if (!workers || workers.length === 0) {
        console.warn('[scheduler] ⚠ No sync worker is consuming the "order-sync" queue.');
        console.warn('[scheduler] ⚠ Scheduled syncs will queue up and never run. Start it with: npm run worker');
        console.warn('[scheduler] ⚠ (Manual syncs from the UI fall back to running in-process.)');
      } else {
        console.log(`[scheduler] ${workers.length} sync worker(s) connected`);
      }
    } catch (err) {
      console.warn(`[scheduler] Could not check for sync workers: ${err.message}`);
    }
  }, CHECK_DELAY_MS);

  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { start, addStore, removeStore, startAwbCleanup, stopAwbCleanup };

