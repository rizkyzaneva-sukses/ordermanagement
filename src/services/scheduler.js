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
const { syncQueue } = require('./queue.js');

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

// ── Core helpers ──────────────────────────────────────────────────────────────

/**
 * Register (or re-register) a repeatable sync job for a single store.
 * Safe to call multiple times — BullMQ deduplicates by jobId.
 *
 * @param {string} storeId
 */
async function addStore(storeId) {
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
  // BullMQ v5+: removeRepeatable(name, repeatOpts, jobId)
  try {
    await syncQueue.removeRepeatable('sync-store', { every: SYNC_INTERVAL_MS }, `auto-sync-${storeId}`);
    console.log(`[scheduler] Repeatable sync removed for store ${storeId}`);
  } catch (err) {
    console.warn(`[scheduler] Could not remove repeatable job for store ${storeId}:`, err.message);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

/**
 * Bootstrap: register repeatable jobs for all currently active stores.
 * Call this once after the server starts.
 */
async function start() {
  console.log(`[scheduler] Starting — sync interval: ${SYNC_INTERVAL_MS / 60_000} min`);

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
}

module.exports = { start, addStore, removeStore };
