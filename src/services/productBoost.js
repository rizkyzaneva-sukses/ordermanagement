'use strict';

/**
 * productBoost.js — Naikkan Produk otomatis.
 *
 * Shopee lets a shop boost 5 items to the top of search results; each slot is
 * held for 4 hours after use. Komplace keeps those slots busy by itself, and
 * operators asked for the same here (30 Okt 2026): switch it on per shop, and
 * every item on sale takes its turn without anyone picking them.
 *
 * Every few minutes, for each shop with auto-boost on:
 *   1. get_boosted_list says how many of the 5 slots are still cooling down —
 *      boosts made by hand in Seller Centre count too, so nothing here has to
 *      guess when a slot frees up.
 *   2. If any are free, the shop's live NORMAL item list is read, and the items
 *      tried longest ago (never-tried first) fill them.
 *   3. Every attempt is written to product_boosts, which is both Riwayat on the
 *      page and the rotation's memory.
 *
 * Komplace also offers "1 Produk / 1 Jam (Berbayar)" — its own paid tier, not a
 * Shopee one. Shopee's limit is 5 per 4 hours, so that is the only mode here.
 */

const prisma = require('../prisma/client.js');
const shopeeService = require('./shopee.js');
const { ensureFreshToken } = require('./tokens.js');

/** Shopee's boost slots per shop. */
const BOOST_SLOTS = 5;

/** How often to look for free slots. A slot waits at most this long unused. */
const CHECK_EVERY_MS = (parseInt(process.env.BOOST_CHECK_MINUTES, 10) || 10) * 60_000;

/** History kept. Longer than one full turn of a large catalogue (30 items a day). */
const RETENTION_DAYS = 60;

/** The reason Shopee gave, without our "Shopee API Error: … (request_id=…)" wrapping. */
function reasonOf(err) {
  return err?.shopeeMessage || err?.shopeeError || err?.message || 'Gagal tanpa keterangan';
}

/**
 * Collapse catalogue rows (one per variation) into one entry per item.
 *
 * Stock is the sum over variations; null when no variation has a known number,
 * because a catalogue pulled before stock sync knows nothing either way.
 *
 * @param {Array<{itemId: string, name?: string, itemName?: string|null, stock?: number|null, imageUrl?: string|null}>} listings
 * @returns {Map<string, {name: string|null, imageUrl: string|null, stock: number|null}>}
 */
function summariseItems(listings) {
  const items = new Map();
  for (const l of listings) {
    const id = String(l.itemId);
    const cur = items.get(id) || { name: null, imageUrl: null, stock: null };
    cur.name = cur.name || l.itemName || l.name || null;
    cur.imageUrl = cur.imageUrl || l.imageUrl || null;
    if (typeof l.stock === 'number') cur.stock = (cur.stock ?? 0) + l.stock;
    items.set(id, cur);
  }
  return items;
}

/**
 * Pick the items that fill the free slots.
 *
 * Skipped: items already boosted, and items the catalogue says have no stock
 * left — boosting a sold-out item to the top only shows buyers something they
 * cannot buy. An item the catalogue does not know (added since the last pull)
 * is still eligible: being on sale is enough.
 *
 * Order: never tried first, then the one tried longest ago. Failed tries count
 * as tries, so an item Shopee keeps refusing goes to the back instead of being
 * retried every few minutes ahead of everything else.
 *
 * @param {Object} p
 * @param {string[]} p.activeItemIds - Items on sale right now
 * @param {Map<string, {stock: number|null}>} p.items - From summariseItems
 * @param {Set<string>} p.boostedIds - Items holding a slot now
 * @param {Map<string, Date>} p.lastTried - Item id → last attempt
 * @param {number} p.slots - Free slots
 * @returns {string[]} Item ids, at most `slots`
 */
function planBoost({ activeItemIds, items, boostedIds, lastTried, slots }) {
  if (slots <= 0) return [];
  const seen = new Set();
  const candidates = [];
  for (const raw of activeItemIds) {
    const id = String(raw);
    if (seen.has(id) || boostedIds.has(id)) continue;
    seen.add(id);
    const stock = items.get(id)?.stock;
    if (stock === 0) continue;
    candidates.push({ id, at: lastTried.get(id)?.getTime() ?? -Infinity });
  }
  candidates.sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return candidates.slice(0, slots).map(c => c.id);
}

/**
 * Sort one boost_item answer into what went up and what did not. An item in
 * neither list counts as failed: claiming a boost that did not happen is the
 * worse mistake.
 *
 * @returns {{ ok: string[], failed: Array<{itemId: string, reason: string}> }}
 */
function readBoostResult(itemIds, response) {
  const okSet = new Set((response?.success_list?.item_id_list || []).map(String));
  const reasons = new Map(
    (response?.failure_list || []).map(f => [String(f.item_id), f.failed_reason || 'Ditolak Shopee'])
  );
  const ok = [];
  const failed = [];
  for (const id of itemIds) {
    if (reasons.has(id)) failed.push({ itemId: id, reason: reasons.get(id) });
    else if (okSet.has(id)) ok.push(id);
    else failed.push({ itemId: id, reason: 'Shopee tidak memberi jawaban untuk produk ini' });
  }
  return { ok, failed };
}

/** Items holding a slot now: `[{ itemId, coolDownSeconds }]`. */
async function readBoosted(accessToken, store) {
  const res = await shopeeService.getBoostedList(accessToken, store.shopId);
  return (res?.response?.item_list || []).map(i => ({
    itemId: String(i.item_id),
    coolDownSeconds: Number(i.cool_down_second) || 0,
  }));
}

/** Last attempt per item in this shop. */
async function readLastTried(storeId) {
  const rows = await prisma.productBoost.groupBy({
    by: ['itemId'],
    where: { storeId },
    _max: { createdAt: true },
  });
  return new Map(rows.map(r => [r.itemId, r._max.createdAt]));
}

async function readCatalogue(storeId) {
  const listings = await prisma.productListing.findMany({
    where: { storeId },
    select: { itemId: true, name: true, itemName: true, stock: true, imageUrl: true, status: true },
  });
  return listings;
}

/** Shops with a pass in flight, so the timer and the button never boost one shop twice at once. */
const running = new Set();

/**
 * Fill one shop's free slots.
 *
 * @param {string} storeId
 * @param {Object} [opts]
 * @param {boolean} [opts.auto=true] - false when an operator pressed the button
 * @returns {Promise<{ freeSlots: number, boosted: string[], failed: Array<{itemId: string, name: string|null, reason: string}>, busy?: boolean }>}
 */
async function runStoreBoost(storeId, { auto = true } = {}) {
  if (running.has(storeId)) return { freeSlots: 0, boosted: [], failed: [], busy: true };
  running.add(storeId);

  try {
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) throw new Error('Toko tidak ditemukan');

    try {
      const accessToken = await ensureFreshToken(store);
      const boosted = await readBoosted(accessToken, store);
      const freeSlots = Math.max(0, BOOST_SLOTS - boosted.length);

      let result = { freeSlots, boosted: [], failed: [] };
      if (freeSlots > 0) {
        const live = await shopeeService.getAllItems(accessToken, store.shopId, { itemStatus: ['NORMAL'] });
        const items = summariseItems(await readCatalogue(storeId));
        const pick = planBoost({
          activeItemIds: live.map(i => String(i.item_id)),
          items,
          boostedIds: new Set(boosted.map(b => b.itemId)),
          lastTried: await readLastTried(storeId),
          slots: freeSlots,
        });

        if (pick.length > 0) {
          const res = await shopeeService.boostItem(accessToken, store.shopId, pick);
          const { ok, failed } = readBoostResult(pick, res?.response);
          const nameOf = id => items.get(id)?.name || null;
          await prisma.productBoost.createMany({
            data: [
              ...ok.map(itemId => ({ storeId, itemId, itemName: nameOf(itemId), ok: true, auto })),
              ...failed.map(f => ({ storeId, itemId: f.itemId, itemName: nameOf(f.itemId), ok: false, reason: f.reason, auto })),
            ],
          });
          result = {
            freeSlots,
            boosted: ok,
            failed: failed.map(f => ({ ...f, name: nameOf(f.itemId) })),
          };
        }
      }

      await prisma.store.update({
        where: { id: storeId },
        data: { boostLastRunAt: new Date(), boostLastError: null },
      });
      if (result.boosted.length || result.failed.length) {
        console.log(`[boost] ${store.name}: ${result.boosted.length} dinaikkan, ${result.failed.length} gagal`);
      }
      return result;
    } catch (err) {
      const reason = reasonOf(err);
      console.error(`[boost] ${store.name} failed: ${reason}`);
      await prisma.store.update({
        where: { id: storeId },
        data: { boostLastRunAt: new Date(), boostLastError: reason },
      }).catch(() => {});
      throw err;
    }
  } finally {
    running.delete(storeId);
  }
}

/** One pass over every shop with auto-boost on. Shops fail independently. */
async function runAllBoosts() {
  const stores = await prisma.store.findMany({
    where: { autoBoost: true, isActive: true, platform: 'SHOPEE', needsReconnect: false },
    select: { id: true },
  });
  for (const s of stores) {
    try {
      await runStoreBoost(s.id);
    } catch {
      // Already recorded on the store and logged
    }
  }
}

/**
 * What the page shows for one shop: the slots in use (live from Shopee), the
 * next items in line, and recent history.
 *
 * "Berikutnya" is read from the catalogue rather than Shopee's live list, so it
 * is an estimate: an item added since the last catalogue pull is not in it yet,
 * though the real pass will still boost it.
 */
async function getStoreBoostState(store) {
  const [catalogue, lastTried, history] = await Promise.all([
    readCatalogue(store.id),
    readLastTried(store.id),
    prisma.productBoost.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
  ]);
  const items = summariseItems(catalogue);

  let boosted = [];
  let liveError = null;
  try {
    const accessToken = await ensureFreshToken(store);
    boosted = await readBoosted(accessToken, store);
  } catch (err) {
    liveError = reasonOf(err);
  }

  const activeItemIds = [...new Set(catalogue.filter(l => l.status === 'NORMAL').map(l => String(l.itemId)))];
  const next = planBoost({
    activeItemIds,
    items,
    boostedIds: new Set(boosted.map(b => b.itemId)),
    lastTried,
    slots: BOOST_SLOTS,
  });

  const describe = id => ({
    itemId: id,
    name: items.get(id)?.name || null,
    imageUrl: items.get(id)?.imageUrl || null,
  });

  return {
    storeId: store.id,
    name: store.name,
    autoBoost: store.autoBoost,
    needsReconnect: store.needsReconnect,
    lastRunAt: store.boostLastRunAt,
    lastError: store.boostLastError,
    liveError,
    slots: BOOST_SLOTS,
    activeItems: activeItemIds.length,
    boosted: boosted
      .map(b => ({ ...describe(b.itemId), coolDownSeconds: b.coolDownSeconds }))
      .sort((a, b) => a.coolDownSeconds - b.coolDownSeconds),
    next: next.map(describe),
    history: history.map(h => ({
      itemId: h.itemId,
      name: h.itemName,
      ok: h.ok,
      reason: h.reason,
      auto: h.auto,
      at: h.createdAt,
    })),
  };
}

async function pruneOld(days = RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { count } = await prisma.productBoost.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count > 0) console.log(`[boost] Pruned ${count} history row(s) older than ${days} days`);
  return count;
}

let timer = null;

/**
 * Start the auto-boost timer. A plain timer like token upkeep: it needs no
 * queue, and a missed tick costs nothing but a few minutes of an idle slot.
 */
function start() {
  if (timer) return;
  const run = () => runAllBoosts().catch(err => console.error('[boost] Pass failed:', err.message));
  // First pass after a minute, not at boot: tokens and Redis settle first.
  setTimeout(run, 60_000).unref?.();
  timer = setInterval(run, CHECK_EVERY_MS);
  timer.unref?.();
  console.log(`[boost] Auto-boost checks every ${CHECK_EVERY_MS / 60_000} min`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  BOOST_SLOTS,
  summariseItems,
  planBoost,
  readBoostResult,
  runStoreBoost,
  runAllBoosts,
  getStoreBoostState,
  pruneOld,
  start,
  stop,
};
