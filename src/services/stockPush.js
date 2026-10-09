'use strict';

/**
 * stockPush.js — send master stock out to the listings bound to it.
 *
 * Runs right after an operator saves a stock number on Daftar Stok: the number
 * they typed is what every bound Shopee listing should now hold. Only masters
 * that were just saved are pushed. A master nobody touched is never re-sent,
 * because master stock is not decremented by orders (rencana fitur produk,
 * 7 Sep 2026) and its number can sit far above what Shopee has left — pushing
 * it unprompted would hand back stock that was already sold.
 *
 * Write permission for `update_stock` was confirmed on 17 Sep 2026.
 */

const prisma = require('../prisma/client.js');
const shopeeService = require('./shopee.js');
const { ensureFreshToken } = require('./tokens.js');
const { mapWithConcurrency, CALL_CONCURRENCY } = require('./syncDirect.js');
const { planStockPush } = require('./productMapping.js');

/** Listings that still hold stock on the marketplace; BANNED/DELETED cannot be written. */
const PUSHABLE_STATUSES = ['NORMAL', 'UNLIST'];

/** Shops handled at once. Each one fans out to CALL_CONCURRENCY item calls. */
const STORE_CONCURRENCY = 3;

/** The reason Shopee gave, without our "Shopee API Error: … (request_id=…)" wrapping. */
function reasonOf(err) {
  return err?.shopeeMessage || err?.shopeeError || err?.message || 'Gagal tanpa keterangan';
}

/**
 * Sort one `update_stock` answer into the listings that took the number and the
 * ones that did not.
 *
 * A model listed in neither `success_list` nor `failure_list` counts as failed
 * rather than done: telling an operator Shopee has 40 when it may not is the
 * worse mistake. A model in both is failed — Shopee said no to some part of it.
 *
 * @param {Array<{listingId: string, modelId: string, stock: number}>} models - What was sent
 * @param {Object|null|undefined} response - `response` of the Shopee answer
 * @returns {{ pushed: Array<{listingId: string, stock: number}>, failed: Array<{listingId: string, reason: string}> }}
 */
function readUpdateStockResult(models, response) {
  const pushed = [];
  const failed = [];
  const byModel = new Map(models.map(m => [String(Number(m.modelId || 0)), m]));
  const answered = new Set();

  for (const f of response?.failure_list || []) {
    const m = byModel.get(String(f.model_id ?? 0));
    if (!m || answered.has(m.listingId)) continue;
    answered.add(m.listingId);
    failed.push({ listingId: m.listingId, reason: f.failed_reason || 'Ditolak Shopee' });
  }
  for (const s of response?.success_list || []) {
    const m = byModel.get(String(s.model_id ?? 0));
    if (!m || answered.has(m.listingId)) continue;
    answered.add(m.listingId);
    pushed.push({ listingId: m.listingId, stock: m.stock });
  }
  for (const m of models) {
    if (!answered.has(m.listingId)) {
      failed.push({ listingId: m.listingId, reason: 'Shopee tidak memberi jawaban untuk varian ini' });
    }
  }
  return { pushed, failed };
}

/**
 * Push one shop's share of the plan.
 *
 * @returns {Promise<{ pushed: Array<{listingId: string, stock: number}>, failed: Array<{listingId: string, reason: string}> }>}
 */
async function pushStore(store, calls) {
  const pushed = [];
  const failed = [];

  let accessToken;
  try {
    accessToken = await ensureFreshToken(store);
  } catch (err) {
    for (const call of calls) {
      for (const m of call.models) failed.push({ listingId: m.listingId, reason: `Token toko: ${reasonOf(err)}` });
    }
    return { pushed, failed };
  }

  await mapWithConcurrency(calls, CALL_CONCURRENCY, async (call) => {
    const stockList = call.models.map(m => ({
      model_id: Number(m.modelId || 0),
      seller_stock: [{ stock: m.stock }],
    }));

    let response;
    try {
      response = (await shopeeService.updateStock(accessToken, store.shopId, Number(call.itemId), stockList)).response;
    } catch (err) {
      // An all-failed batch comes back as a top-level error with the per-model
      // reasons still in `response.failure_list`; read those when they exist.
      response = err.shopeeResponse;
      if (!Array.isArray(response?.failure_list) || response.failure_list.length === 0) {
        console.warn(`[stockPush] Store ${store.id} item ${call.itemId} failed: ${err.message}`);
        for (const m of call.models) failed.push({ listingId: m.listingId, reason: reasonOf(err) });
        return;
      }
    }

    const outcome = readUpdateStockResult(call.models, response);
    pushed.push(...outcome.pushed);
    failed.push(...outcome.failed);
  });

  return { pushed, failed };
}

/**
 * Write each master's stock to every Shopee listing bound to it.
 *
 * Best effort per listing: one refused variation does not stop the rest, and
 * the master's own number is already saved before this runs. What failed comes
 * back by name so the operator knows which shop to fix by hand.
 *
 * @param {string[]} productIds - Masters that were just saved
 * @returns {Promise<{
 *   listings: number, pushed: number,
 *   failed: Array<{ store: string, name: string, reason: string }>,
 *   skipped: Array<{ store: string, name: string, reason: string }>
 * }>}
 */
async function pushMasterStock(productIds) {
  const ids = [...new Set((productIds || []).map(String))];
  const empty = { listings: 0, pushed: 0, failed: [], skipped: [] };
  if (ids.length === 0) return empty;

  const listings = await prisma.productListing.findMany({
    where: { productId: { in: ids }, status: { in: PUSHABLE_STATUSES } },
    select: {
      id: true, storeId: true, itemId: true, modelId: true, name: true,
      product: { select: { stock: true } },
      // Whole row: ensureFreshToken reads the token columns and may rotate them.
      store: true,
    },
  });
  if (listings.length === 0) return empty;

  const skipped = [];
  const targets = [];
  const stores = new Map();
  const byId = new Map(listings.map(l => [l.id, l]));

  for (const l of listings) {
    let reason = null;
    if (l.store.platform === 'TIKTOK') reason = 'TikTok belum didukung';
    else if (l.store.platform !== 'SHOPEE') reason = `${l.store.platform} belum didukung`;
    else if (!l.store.isActive) reason = 'Toko nonaktif';
    else if (l.store.needsReconnect) reason = 'Toko perlu dihubungkan ulang';

    if (reason) {
      skipped.push({ store: l.store.name, name: l.name, reason });
      continue;
    }
    stores.set(l.storeId, l.store);
    targets.push({ id: l.id, storeId: l.storeId, itemId: l.itemId, modelId: l.modelId, stock: l.product.stock });
  }

  const plan = planStockPush(targets);
  const outcomes = await mapWithConcurrency([...plan], STORE_CONCURRENCY,
    ([storeId, calls]) => pushStore(stores.get(storeId), calls));

  const pushed = outcomes.flatMap(o => o.pushed);
  const failed = outcomes.flatMap(o => o.failed);

  // Shopee now holds what we sent, so the "Di Shopee" column says so without
  // waiting for the next stock refresh. Grouped by value: a push is usually a
  // handful of numbers across many listings.
  const now = new Date();
  const byStock = new Map();
  for (const p of pushed) {
    if (!byStock.has(p.stock)) byStock.set(p.stock, []);
    byStock.get(p.stock).push(p.listingId);
  }
  for (const [stock, listingIds] of byStock) {
    await prisma.productListing.updateMany({
      where: { id: { in: listingIds } },
      data: { stock, lastSyncedAt: now },
    });
  }

  console.log(
    `[stockPush] ${ids.length} master(s): ${pushed.length} listing(s) pushed, ` +
    `${failed.length} failed, ${skipped.length} skipped`
  );

  return {
    listings: listings.length,
    pushed: pushed.length,
    failed: failed.map(f => {
      const l = byId.get(f.listingId);
      return { store: l.store.name, name: l.name, reason: f.reason };
    }),
    skipped,
  };
}

module.exports = { pushMasterStock, readUpdateStockResult };
