'use strict';

/**
 * tokens.js — marketplace access token lifecycle.
 *
 * Shopee issues an access token valid ~4 hours and a refresh token valid
 * ~30 days, and **rotates the refresh token on every refresh**. Two consequences
 * drive everything here:
 *
 *   1. If nothing refreshes for 30 days the refresh token dies and the merchant
 *      has to re-authorize by hand. Refreshing only when a sync happens is
 *      therefore not enough — a stalled sync silently burns the connection.
 *      `refreshExpiringTokens()` runs on a timer to keep the chain alive.
 *
 *   2. Because the old refresh token is consumed, two concurrent refreshes for
 *      one store mean the loser receives `error_not_found` even though nothing
 *      is wrong. With the API and the worker running as separate containers this
 *      is easy to hit, so refreshes are serialized with a Postgres advisory
 *      lock that spans processes.
 */

const prisma = require('../prisma/client.js');
const { encrypt, decrypt } = require('../utils/crypto.js');
const shopeeService = require('./shopee.js');
const tiktokService = require('./tiktok.js');

/** Refresh when this little time is left on the access token. */
const TOKEN_BUFFER_MINUTES = 5;

/** Access token lifetime per platform, in hours. */
const TOKEN_LIFETIME_HOURS = { SHOPEE: 4, TIKTOK: 24 };

/** Namespace for the advisory lock, keeping it clear of other users of the DB. */
const LOCK_NAMESPACE = 4242;

/**
 * Errors that mean the merchant must re-authorize; retrying will not help.
 *
 * Shopee answers a dead or already-consumed refresh token with
 * `error_not_found`, which is not distinguishable by HTTP status alone.
 */
const RECONNECT_SIGNATURES = [
  'error_not_found',
  'invalid_refresh_token',
  'invalid_access_token',
  'error_auth',
  'no refresh token available',
];

function isReconnectError(message = '') {
  const lower = String(message).toLowerCase();
  return RECONNECT_SIGNATURES.some(sig => lower.includes(sig));
}

/**
 * Map a store id onto a signed 32-bit integer for pg_advisory_xact_lock.
 *
 * Collisions only cost a little needless serialization between two unrelated
 * stores, so a cheap hash is fine.
 */
function storeLockId(storeId) {
  let hash = 0;
  for (let i = 0; i < storeId.length; i++) {
    hash = (Math.imul(hash, 31) + storeId.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Minutes remaining on a store's access token (negative once expired). */
function minutesLeft(store) {
  const expiry = store.tokenExpiry ? new Date(store.tokenExpiry) : new Date(0);
  return (expiry.getTime() - Date.now()) / 60_000;
}

/**
 * Call the platform's refresh endpoint and persist the rotated pair.
 *
 * Assumes the caller already holds the per-store lock.
 *
 * @param {Object} tx    - Prisma transaction client
 * @param {Object} store - Fresh store row read inside the lock
 * @returns {Promise<string>} The new access token
 */
async function performRefresh(tx, store) {
  if (!store.refreshToken) {
    throw new Error(`Store ${store.id}: token expired and no refresh token available. Please reconnect the store.`);
  }

  const refreshToken = decrypt(store.refreshToken);
  let newAccessToken;
  let newRefreshToken;

  if (store.platform === 'SHOPEE') {
    const result = await shopeeService.refreshToken(refreshToken, store.shopId);
    newAccessToken = result.access_token;
    newRefreshToken = result.refresh_token;
  } else if (store.platform === 'TIKTOK') {
    const result = await tiktokService.refreshToken(refreshToken);
    newAccessToken = result.access_token;
    newRefreshToken = result.refresh_token;
  } else {
    throw new Error(`Store ${store.id}: unsupported platform ${store.platform} for token refresh`);
  }

  if (!newAccessToken) {
    throw new Error(`Store ${store.id}: refresh call returned no access_token`);
  }

  const expiryHours = TOKEN_LIFETIME_HOURS[store.platform] || 4;
  const data = {
    accessToken: encrypt(newAccessToken),
    tokenExpiry: new Date(Date.now() + expiryHours * 60 * 60 * 1000),
    needsReconnect: false,
  };

  // The platform has already invalidated the old refresh token, so failing to
  // store the new one locks us out until the merchant re-authorizes.
  if (newRefreshToken) {
    data.refreshToken = encrypt(newRefreshToken);
  } else {
    console.warn(`[token] Store ${store.id}: refresh returned no new refresh_token — keeping the existing one`);
  }

  await tx.store.update({ where: { id: store.id }, data });

  console.log(`[token] Store ${store.id} (${store.platform}) refreshed — valid for ${expiryHours}h`);
  return newAccessToken;
}

/**
 * Return a usable access token for a store, refreshing it if it is about to expire.
 *
 * The refresh is serialized per store across every process touching this
 * database, and re-checks the expiry after acquiring the lock so a token another
 * process just refreshed is reused instead of being refreshed again.
 *
 * @param {Object} store - Store row (may be slightly stale)
 * @returns {Promise<string>} A valid access token
 */
async function ensureFreshToken(store) {
  const remaining = minutesLeft(store);

  if (remaining > TOKEN_BUFFER_MINUTES) {
    console.log(`[token] Store ${store.id} token valid for ~${Math.floor(remaining)} more minutes`);
    return decrypt(store.accessToken);
  }

  console.log(`[token] Store ${store.id} token expiring (${remaining.toFixed(1)} min left) — acquiring refresh lock`);

  try {
    return await prisma.$transaction(async (tx) => {
      // Blocks until any other process refreshing this store has finished
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, ${storeLockId(store.id)}::int)`;

      const current = await tx.store.findUnique({ where: { id: store.id } });
      if (!current) throw new Error(`Store ${store.id} no longer exists`);

      // Someone else may have refreshed while we waited for the lock
      const remainingNow = minutesLeft(current);
      if (remainingNow > TOKEN_BUFFER_MINUTES) {
        console.log(`[token] Store ${store.id} was refreshed by another process (${Math.floor(remainingNow)} min left) — reusing`);
        return decrypt(current.accessToken);
      }

      return performRefresh(tx, current);
    }, {
      // The transaction spans an HTTP call to the marketplace
      timeout: 30_000,
      maxWait: 20_000,
    });
  } catch (err) {
    if (isReconnectError(err.message)) {
      console.error(`[token] Store ${store.id} needs re-authorization: ${err.message}`);
      await prisma.store.update({
        where: { id: store.id },
        data: { needsReconnect: true },
      }).catch(() => { /* store may be gone */ });
    }
    throw err;
  }
}

/**
 * Proactively refresh every token that is close to expiring.
 *
 * This is what stops the 30-day refresh-token window from ever lapsing: as long
 * as this runs, the chain keeps rolling and the merchant never has to log in
 * again. Stores already flagged `needsReconnect` are skipped — only a human can
 * fix those, and hammering the endpoint achieves nothing.
 *
 * @param {number} [thresholdMinutes=90] - Refresh tokens expiring within this window
 * @returns {Promise<{ checked: number, refreshed: number, failed: number }>}
 */
async function refreshExpiringTokens(thresholdMinutes = 90) {
  const cutoff = new Date(Date.now() + thresholdMinutes * 60_000);

  const stores = await prisma.store.findMany({
    where: {
      isActive: true,
      needsReconnect: false,
      OR: [
        { tokenExpiry: { lt: cutoff } },
        { tokenExpiry: null },
      ],
    },
  });

  if (stores.length === 0) {
    console.log('[token] Proactive refresh: no tokens due');
    return { checked: 0, refreshed: 0, failed: 0 };
  }

  console.log(`[token] Proactive refresh: ${stores.length} store(s) due`);

  let refreshed = 0;
  let failed = 0;

  for (const store of stores) {
    try {
      await ensureFreshToken(store);
      refreshed++;
    } catch (err) {
      failed++;
      console.error(`[token] Proactive refresh failed for store ${store.id} (${store.name}): ${err.message}`);
    }
  }

  console.log(`[token] Proactive refresh done: ${refreshed} refreshed, ${failed} failed`);
  return { checked: stores.length, refreshed, failed };
}

module.exports = {
  ensureFreshToken,
  refreshExpiringTokens,
  isReconnectError,
  minutesLeft,
  TOKEN_BUFFER_MINUTES,
  TOKEN_LIFETIME_HOURS,
};
