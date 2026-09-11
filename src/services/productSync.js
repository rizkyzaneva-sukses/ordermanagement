'use strict';

/**
 * productSync.js — pull a shop's catalogue into `product_listings`.
 *
 * Read-only by design. Nothing here writes to the marketplace: this is the step
 * that makes the catalogue visible in OrderPro, and it needs no product write
 * permission, which has not been confirmed for this partner yet.
 *
 * Shopee splits a catalogue across three calls, and all three are needed:
 *
 *   get_item_list       ids and status, 100 at a time
 *   get_item_base_info  names, images, price and stock, 50 ids at a time
 *   get_model_list      the variations of one item, one item at a time
 *
 * The last one is the expensive one. A fashion shop is mostly multi-variant, so
 * a naive pull is one call per listing — which is why it runs through the same
 * bounded concurrency the order sync uses rather than a plain loop.
 */

const prisma = require('../prisma/client.js');
const shopeeService = require('./shopee.js');
const { ensureFreshToken } = require('./tokens.js');
const { mapWithConcurrency, CALL_CONCURRENCY } = require('./syncDirect.js');

/**
 * Which listings to pull.
 *
 * UNLIST is included deliberately: an unlisted product still holds stock and
 * still needs a master, and leaving it out would make the totals here disagree
 * with the shop's own counts for no reason an operator could work out.
 */
const ITEM_STATUSES = ['NORMAL', 'UNLIST'];

/** Shopee's cap for get_item_base_info. */
const BASE_INFO_CHUNK = 50;

/**
 * Outcome of the most recent pull, so the UI can say why nothing arrived.
 *
 * A pull answers before it finishes, which means a failure — a missing Product
 * permission being the likeliest one — reaches the operator as an empty table
 * and nothing else. Held in memory rather than a column because it is a
 * diagnostic for an operator-initiated job, not a fact about a store: it should
 * not outlive the process that produced it.
 */
let lastPull = null;

/** @returns {Object|null} The last pull's outcome, or null if none has run. */
function getLastPull() {
  return lastPull;
}

function recordPull(outcome) {
  lastPull = { ...outcome, at: new Date().toISOString() };
  return lastPull;
}

/**
 * First price Shopee offers for a listing, in whole currency units.
 *
 * `price_info` is a list because a listing can be priced per region, and the
 * field names have varied between API revisions. Returning null rather than 0
 * matters: 0 is a price, "we could not read it" is not.
 *
 * @param {Object} source - An item or a model
 * @returns {number|null}
 */
function readPrice(source) {
  const list = Array.isArray(source?.price_info) ? source.price_info : [];
  const first = list[0] || {};
  const value = first.current_price ?? first.original_price ?? source?.current_price;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sellable stock for a listing.
 *
 * Reads `stock_info_v2` and falls back to the older `stock_info` list, because
 * which one a shop's API version returns is not something this codebase can
 * check without live credentials. Null means unreadable, not zero — showing a
 * confident 0 next to a product that actually has stock is the one outcome
 * worth avoiding here.
 *
 * @param {Object} source - An item or a model
 * @returns {number|null}
 */
function readStock(source) {
  const summary = source?.stock_info_v2?.summary_info;
  const fromV2 = summary?.total_available_stock ?? summary?.total_reserved_stock;
  if (Number.isFinite(Number(fromV2))) return Number(fromV2);

  const legacy = Array.isArray(source?.stock_info) ? source.stock_info : [];
  const seller = legacy.find(s => s?.stock_type === 2) || legacy[0];
  const fromLegacy = seller?.current_stock ?? seller?.normal_stock;
  return Number.isFinite(Number(fromLegacy)) ? Number(fromLegacy) : null;
}

/** First image URL, if the response carried one. */
function readImage(item) {
  const list = item?.image?.image_url_list;
  return Array.isArray(list) && list.length > 0 ? String(list[0]) : null;
}

/**
 * Turn one item (plus its models, if any) into the rows we store.
 *
 * An item with variations sells through its models, not through itself, so it
 * contributes one row per model and none of its own — storing both would double
 * every multi-variant listing and make the stock figures meaningless.
 *
 * @param {Object} item - An entry from get_item_base_info
 * @param {Array<Object>} models - Entries from get_model_list, empty if none
 * @returns {Array<Object>}
 */
function buildListingRows(item, models = []) {
  const shared = {
    itemId: String(item.item_id),
    status: item.item_status || 'NORMAL',
    imageUrl: readImage(item),
  };

  if (models.length === 0) {
    return [{
      ...shared,
      modelId: '',
      sku: item.item_sku || null,
      name: item.item_name || `Item ${item.item_id}`,
      price: readPrice(item),
      stock: readStock(item),
    }];
  }

  return models.map((model) => ({
    ...shared,
    modelId: String(model.model_id),
    sku: model.model_sku || item.item_sku || null,
    // Shopee does not repeat the item name on a model, and a variation shown as
    // its bare option ("XL / Navy") is unrecognisable in a list of 1300.
    name: model.model_name
      ? `${item.item_name} — ${model.model_name}`
      : (item.item_name || `Item ${item.item_id}`),
    price: readPrice(model),
    stock: readStock(model),
  }));
}

/**
 * Pull one Shopee shop's catalogue and persist it.
 *
 * @param {string} storeId
 * @returns {Promise<{ storeId: string, listings: number, items: number, warnings: string[] }>}
 */
async function syncStoreCatalogue(storeId) {
  const startedAt = Date.now();
  const warnings = [];

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error(`Store ${storeId} not found`);
  if (store.platform !== 'SHOPEE') {
    // Not an error: the schema is platform-neutral so TikTok can join later,
    // but no TikTok catalogue client exists to call yet.
    console.log(`[catalogue] Store ${storeId} is ${store.platform} — no catalogue client for it yet, skipping`);
    return { storeId, listings: 0, items: 0, warnings: [`${store.platform} not supported yet`] };
  }

  const accessToken = await ensureFreshToken(store);
  const shopId = store.shopId;

  console.log(`[catalogue] Starting catalogue pull for store ${storeId} (${store.name})`);

  // Not wrapped in a broader try: a failure here is the whole pull failing, and
  // the caller records it. But it is worth naming, because the likeliest cause
  // by far is the app lacking the Product permission — an error an operator can
  // act on, and one that is indistinguishable from "shop has no products" if it
  // only ever reaches a log file.
  let items;
  try {
    items = await shopeeService.getAllItems(accessToken, shopId, { itemStatus: ITEM_STATUSES });
  } catch (err) {
    throw new Error(`get_item_list ditolak Shopee: ${err.message}`);
  }

  if (items.length === 0) {
    console.log(`[catalogue] Store ${storeId}: no items returned`);
    return { storeId, storeName: store.name, listings: 0, items: 0, warnings };
  }

  const idChunks = [];
  for (let i = 0; i < items.length; i += BASE_INFO_CHUNK) {
    idChunks.push(items.slice(i, i + BASE_INFO_CHUNK).map(it => it.item_id));
  }

  const infoChunks = await mapWithConcurrency(idChunks, CALL_CONCURRENCY, async (ids) => {
    try {
      const resp = await shopeeService.getItemBaseInfo(accessToken, shopId, ids);
      return resp.response?.item_list || [];
    } catch (err) {
      // Best effort per chunk: losing 50 listings is better than losing 1300.
      console.warn(`[catalogue] Base info failed for ${ids.length} item(s): ${err.message}`);
      warnings.push(`base_info(${ids.length}): ${err.message}`);
      return [];
    }
  });

  const baseInfos = infoChunks.flat();

  // Only multi-variant items cost a model call, which on a shop that is mostly
  // multi-variant is still most of them — hence the concurrency.
  const withModels = baseInfos.filter(it => it.has_model);
  console.log(`[catalogue] Store ${storeId}: ${baseInfos.length} item(s), ${withModels.length} with variations`);

  const modelsByItem = new Map();
  await mapWithConcurrency(withModels, CALL_CONCURRENCY, async (item) => {
    try {
      const resp = await shopeeService.getModelList(accessToken, shopId, item.item_id);
      modelsByItem.set(String(item.item_id), resp.response?.model || []);
    } catch (err) {
      // Falls through to a single row for the item. Its stock will be the
      // item-level figure, which is the sum across variations — wrong for
      // per-variation work, but visible and clearly attributable in the log.
      console.warn(`[catalogue] Model list failed for item ${item.item_id}: ${err.message}`);
      warnings.push(`models(${item.item_id}): ${err.message}`);
    }
  });

  const rows = baseInfos.flatMap(item =>
    buildListingRows(item, modelsByItem.get(String(item.item_id)) || []));

  await upsertListings(store, rows);

  console.log(
    `[catalogue] Completed store ${storeId}: ${rows.length} listing(s) from ${baseInfos.length} item(s) ` +
    `in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );

  return { storeId, storeName: store.name, listings: rows.length, items: baseInfos.length, warnings };
}

/**
 * Write the pulled rows, leaving any master mapping alone.
 *
 * `productId` is never touched here: it is an operator's decision, and a
 * catalogue refresh that silently unmapped a master would undo their work every
 * fifteen minutes.
 *
 * @param {Object} store
 * @param {Array<Object>} rows
 */
async function upsertListings(store, rows) {
  const now = new Date();

  for (const row of rows) {
    const data = {
      platform: store.platform,
      sku: row.sku,
      name: row.name,
      status: row.status,
      price: row.price,
      stock: row.stock,
      imageUrl: row.imageUrl,
      lastSyncedAt: now,
    };

    await prisma.productListing.upsert({
      where: {
        storeId_itemId_modelId: {
          storeId: store.id,
          itemId: row.itemId,
          modelId: row.modelId,
        },
      },
      update: data,
      create: {
        ...data,
        storeId: store.id,
        itemId: row.itemId,
        modelId: row.modelId,
      },
    });
  }
}

/**
 * Pull every active Shopee shop's catalogue, one shop at a time.
 *
 * Sequential across shops on purpose: each shop already fans out internally, and
 * running several at once multiplies that against a per-shop rate limit for no
 * gain an operator would notice on a job this infrequent.
 *
 * @returns {Promise<Array<Object>>}
 */
async function syncAllCatalogues() {
  const stores = await prisma.store.findMany({
    where: { isActive: true, platform: 'SHOPEE', needsReconnect: false },
    select: { id: true, name: true },
  });

  if (stores.length === 0) {
    // Worth distinguishing from "pulled everything and found nothing": there is
    // no shop to pull from, which is a different problem with a different fix.
    console.warn('[catalogue] No active Shopee store to pull from');
    recordPull({ stores: 0, listings: 0, failed: 0, errors: ['Tidak ada toko Shopee aktif yang bisa ditarik'] });
    return [];
  }

  const results = [];
  const errors = [];

  for (const store of stores) {
    try {
      results.push(await syncStoreCatalogue(store.id));
    } catch (err) {
      console.error(`[catalogue] Store ${store.id} (${store.name}) failed: ${err.message}`);
      errors.push(`${store.name}: ${err.message}`);
      results.push({ storeId: store.id, storeName: store.name, listings: 0, items: 0, warnings: [err.message] });
    }
  }

  recordPull({
    stores: stores.length,
    listings: results.reduce((sum, r) => sum + r.listings, 0),
    failed: errors.length,
    // Every store usually fails for the same reason (one app, one permission),
    // so repeating it seven times buries the answer rather than reinforcing it.
    errors: [...new Set(errors)],
  });

  return results;
}

// ── Stock refresh ─────────────────────────────────────────────────────────────
//
// A catalogue pull and a stock refresh read the same fields from the same two
// endpoints, so this could have been a flag on `syncStoreCatalogue`. It is not,
// because the two answer different questions at different frequencies: the
// catalogue changes when an operator adds a product, stock changes with every
// sale. Keeping them apart lets the cheap one run often without dragging the
// expensive one along.

/**
 * Outcome of the most recent stock refresh.
 *
 * In memory for the same reason `lastPull` is — see the note there. It does not
 * survive a restart, and it is not meant to.
 */
let lastStockSync = null;

/** @returns {Object|null} The last stock refresh's outcome, or null if none has run. */
function getLastStockSync() {
  return lastStockSync;
}

function recordStockSync(outcome) {
  lastStockSync = { ...outcome, at: new Date().toISOString() };
  return lastStockSync;
}

/**
 * Split the listings we already hold into the two calls that can read stock.
 *
 * A catalogue pull has to ask Shopee which items exist (`get_item_list`) and
 * which of them have variations (`get_item_base_info`). A refresh knows both
 * already: the rows carry the item ids, and a row with a `modelId` is by
 * definition a variation. Skipping those two questions is the whole reason this
 * costs less than pulling the catalogue again.
 *
 * An item counts as multi-variant if *any* of its rows has a model, not all of
 * them — reading a variant item at item level returns the sum across its
 * variations, and writing that total onto every row would inflate each one.
 *
 * @param {Array<{itemId: string, modelId: string}>} listings
 * @returns {{ withModels: string[], withoutModels: string[] }}
 */
function planStockRefresh(listings) {
  const hasModels = new Map();
  for (const { itemId, modelId } of listings) {
    hasModels.set(itemId, (hasModels.get(itemId) || false) || modelId !== '');
  }

  const withModels = [];
  const withoutModels = [];
  for (const [itemId, variant] of hasModels) {
    (variant ? withModels : withoutModels).push(itemId);
  }
  return { withModels, withoutModels };
}

/**
 * Re-read stock for every listing this store already has, and write what moved.
 *
 * Deliberately blind to listings it has never seen: a refresh can re-read a
 * product, not discover one. Discovering is what the catalogue pull is for, and
 * conflating the two would make the cheap button quietly as expensive as the
 * expensive one.
 *
 * @param {string} storeId
 * @returns {Promise<{ storeId: string, storeName: string, checked: number, updated: number, missing: number, warnings: string[] }>}
 */
async function syncStoreStock(storeId) {
  const startedAt = Date.now();
  const warnings = [];

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error(`Store ${storeId} not found`);
  if (store.platform !== 'SHOPEE') {
    return { storeId, storeName: store.name, checked: 0, updated: 0, missing: 0,
      warnings: [`${store.platform} not supported yet`] };
  }

  const known = await prisma.productListing.findMany({
    where: { storeId, status: { in: ITEM_STATUSES } },
    select: { itemId: true, modelId: true, stock: true },
  });

  if (known.length === 0) {
    // Not an error, and worth saying plainly: nothing to refresh here means the
    // catalogue has never been pulled, which is a different button.
    return { storeId, storeName: store.name, checked: 0, updated: 0, missing: 0,
      warnings: ['Katalog toko ini masih kosong — tarik katalog dulu'] };
  }

  const accessToken = await ensureFreshToken(store);
  const shopId = store.shopId;
  const { withModels, withoutModels } = planStockRefresh(known);

  console.log(
    `[stock] Store ${storeId} (${store.name}): refreshing ${known.length} listing(s) — ` +
    `${withModels.length} item(s) with variations, ${withoutModels.length} without`
  );

  /** `${itemId}::${modelId}` → stock as Shopee reports it right now. */
  const fresh = new Map();

  await mapWithConcurrency(withModels, CALL_CONCURRENCY, async (itemId) => {
    try {
      const resp = await shopeeService.getModelList(accessToken, shopId, itemId);
      for (const model of resp.response?.model || []) {
        fresh.set(`${itemId}::${model.model_id}`, readStock(model));
      }
    } catch (err) {
      // Best effort per item, as in the catalogue pull: one refused item should
      // not cost the other eleven thousand their refresh.
      console.warn(`[stock] Model list failed for item ${itemId}: ${err.message}`);
      warnings.push(`models(${itemId}): ${err.message}`);
    }
  });

  const idChunks = [];
  for (let i = 0; i < withoutModels.length; i += BASE_INFO_CHUNK) {
    idChunks.push(withoutModels.slice(i, i + BASE_INFO_CHUNK));
  }

  await mapWithConcurrency(idChunks, CALL_CONCURRENCY, async (ids) => {
    try {
      const resp = await shopeeService.getItemBaseInfo(accessToken, shopId, ids);
      for (const item of resp.response?.item_list || []) {
        fresh.set(`${item.item_id}::`, readStock(item));
      }
    } catch (err) {
      console.warn(`[stock] Base info failed for ${ids.length} item(s): ${err.message}`);
      warnings.push(`base_info(${ids.length}): ${err.message}`);
    }
  });

  const now = new Date();
  let updated = 0;
  let missing = 0;

  for (const row of known) {
    const key = `${row.itemId}::${row.modelId}`;
    if (!fresh.has(key)) {
      // Held here but not returned by Shopee: usually a variation deleted since
      // the last catalogue pull. Left exactly as it is — writing zero would read
      // as sold out, and removing the row is the pull's decision, not this one's.
      missing++;
      continue;
    }

    const next = fresh.get(key);
    // Most stock does not move between refreshes. Writing every row back to the
    // value it already held is the one thing that would make this slower than
    // the catalogue pull it exists to avoid.
    if (next === row.stock) continue;

    await prisma.productListing.update({
      where: {
        storeId_itemId_modelId: { storeId, itemId: row.itemId, modelId: row.modelId },
      },
      data: { stock: next, lastSyncedAt: now },
    });
    updated++;
  }

  console.log(
    `[stock] Completed store ${storeId}: ${updated} of ${known.length} listing(s) changed, ` +
    `${missing} no longer returned by Shopee, in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );

  return { storeId, storeName: store.name, checked: known.length, updated, missing, warnings };
}

/**
 * Refresh stock for every active Shopee shop, one shop at a time.
 *
 * Sequential across shops for the same reason `syncAllCatalogues` is.
 *
 * @returns {Promise<Array<Object>>}
 */
async function syncAllStock() {
  const stores = await prisma.store.findMany({
    where: { isActive: true, platform: 'SHOPEE', needsReconnect: false },
    select: { id: true, name: true },
  });

  if (stores.length === 0) {
    console.warn('[stock] No active Shopee store to refresh');
    recordStockSync({ stores: 0, checked: 0, updated: 0, failed: 0,
      errors: ['Tidak ada toko Shopee aktif yang bisa disegarkan'] });
    return [];
  }

  const results = [];
  const errors = [];

  for (const store of stores) {
    try {
      results.push(await syncStoreStock(store.id));
    } catch (err) {
      console.error(`[stock] Store ${store.id} (${store.name}) failed: ${err.message}`);
      errors.push(`${store.name}: ${err.message}`);
      results.push({ storeId: store.id, storeName: store.name, checked: 0, updated: 0,
        missing: 0, warnings: [err.message] });
    }
  }

  recordStockSync({
    stores: stores.length,
    checked: results.reduce((sum, r) => sum + r.checked, 0),
    updated: results.reduce((sum, r) => sum + r.updated, 0),
    failed: errors.length,
    errors: [...new Set(errors)],
  });

  return results;
}

module.exports = {
  syncStoreCatalogue,
  syncAllCatalogues,
  syncStoreStock,
  syncAllStock,
  getLastStockSync,
  recordStockSync,
  getLastPull,
  recordPull,
  // Exported for testing: the row-shaping rules are where a wrong reading of
  // Shopee's response turns into wrong stock on screen, and they can be checked
  // without a database or a live shop.
  buildListingRows,
  readPrice,
  readStock,
  // Exported for testing: decides which endpoint reads a given item's stock, and
  // getting it wrong writes an item-level total onto every variation of it.
  planStockRefresh,
};
