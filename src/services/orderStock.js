'use strict';

/**
 * orderStock.js — stok otomatis: paid orders take master stock, cancelled ones
 * give it back, and the new numbers go out to every shop.
 *
 * Decided by Rizky on 10 Oct 2026 (PRD-stok-otomatis.md), reversing the
 * "stok manual" decision of 7 Sep:
 *   1. stock is taken when an order is paid, not when it is placed
 *   2. an order cancelled before it shipped gives its stock back
 *   3. a return (shipped, then sent back) does not — operators check the
 *      goods and add them by hand
 *   4. only orders placed after an admin switches this on count, so the
 *      switch-on follows a stock opname
 *
 * Runs after each store's order sync. Sync re-reads the same orders over and
 * over, so every step is idempotent twice over: the order rows remember what
 * was done (`stockCountedAt` / `stockReleasedAt`), and the ledger's unique key
 * refuses a second movement for the same order line.
 */

const prisma = require('../prisma/client.js');
const { pushMasterStock } = require('./stockPush.js');

const SETTING_KEY = 'stockAutoDeductSince';

/** Paid and not cancelled. UNPAID never takes stock; CANCELLED is handled below. */
const PAID_STATUSES = [
  'READY_TO_SHIP', 'PROCESSED', 'RETRY_SHIP', 'SHIPPED', 'TO_CONFIRM_RECEIVE',
  'COMPLETED', 'IN_CANCEL', 'TO_RETURN', 'INVOICE_PENDING',
];

/** Order statuses that mean the parcel left the warehouse. */
const SHIPPED_STATUSES = ['SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED', 'TO_RETURN'];

/**
 * Logistics statuses that mean the same. Checked as well as the order status
 * because sync can miss the SHIPPED window entirely — a parcel that fails
 * delivery between two syncs goes straight from PROCESSED to CANCELLED, and its
 * logistics status is the only trace that it ever left.
 */
const SHIPPED_LOGISTICS = [
  'LOGISTICS_PICKUP_DONE', 'LOGISTICS_DELIVERY_DONE', 'LOGISTICS_DELIVERY_FAILED',
  'LOGISTICS_LOST', 'LOGISTICS_COD_REJECTED',
];

// ── Setting ─────────────────────────────────────────────────────────────────

/** @returns {Promise<Date|null>} When stok otomatis was switched on, or null if it is off. */
async function getAutoDeductSince() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return null;
  const since = new Date(row.value);
  return Number.isNaN(since.getTime()) ? null : since;
}

/**
 * Switch stok otomatis on (from now) or off.
 *
 * Switching on again restarts the clock: orders placed while it was off were
 * never counted, and the stock opname that precedes switching on already
 * reflects them.
 *
 * @returns {Promise<Date|null>} The new start time, or null when switched off
 */
async function setAutoDeduct(enabled) {
  if (!enabled) {
    await prisma.appSetting.deleteMany({ where: { key: SETTING_KEY } });
    return null;
  }
  const since = new Date();
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: since.toISOString() },
    update: { value: since.toISOString() },
  });
  return since;
}

// ── Pure rules ──────────────────────────────────────────────────────────────

/** Shopee sends model_id 0 for an item without variations; listings store "". */
function normaliseModelId(modelId) {
  const s = modelId === null || modelId === undefined ? '' : String(modelId);
  return s === '0' ? '' : s;
}

/**
 * What one order took, per variation, from all of its package rows.
 *
 * A split order is stored as one row per package, and each row's items come
 * from matching the package back to the order's item list — so the same order
 * line can show up on two rows with the full order quantity both times. Lines
 * that carry an `orderItemId` are therefore counted once however many rows
 * repeat them. Lines without one (a package item Shopee did not match) are
 * summed, as they are the package's own quantity.
 *
 * @param {Array<Array<Object>>} rowItems - The parsed `items` of each package row
 * @returns {Array<{ itemId: string, modelId: string, quantity: number }>}
 */
function orderLines(rowItems) {
  const seen = new Set();
  const totals = new Map();

  for (const items of rowItems) {
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.itemId === undefined || item?.itemId === null) continue;
      const itemId = String(item.itemId);
      const modelId = normaliseModelId(item.modelId);
      const quantity = Math.max(0, Math.trunc(Number(item.quantity) || 0));
      if (quantity === 0) continue;

      if (item.orderItemId !== undefined && item.orderItemId !== null) {
        const lineKey = `${item.orderItemId}::${itemId}::${modelId}`;
        if (seen.has(lineKey)) continue;
        seen.add(lineKey);
      }

      const key = `${itemId}::${modelId}`;
      totals.set(key, (totals.get(key) || 0) + quantity);
    }
  }

  return [...totals].map(([key, quantity]) => {
    const [itemId, modelId] = key.split('::');
    return { itemId, modelId, quantity };
  });
}

/** Whether any of an order's package rows shows it left the warehouse. */
function hasShipped(rows) {
  return rows.some(r =>
    r.stockShippedAt ||
    SHIPPED_STATUSES.includes(r.status) ||
    SHIPPED_LOGISTICS.includes(r.logisticsStatus));
}

/**
 * Stock after taking `quantity`, floored at 0.
 *
 * @returns {{ next: number, delta: number, short: number }}
 *   `delta` is what was really taken; `short` is how much the order wanted
 *   beyond what there was — a likely oversell.
 */
function planTake(stock, quantity) {
  const next = Math.max(0, stock - quantity);
  return { next, delta: next - stock, short: Math.max(0, quantity - stock) };
}

// ── Database steps ──────────────────────────────────────────────────────────

/** Group order rows (one per package) by order_sn. */
function byOrder(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.orderId)) groups.set(r.orderId, []);
    groups.get(r.orderId).push(r);
  }
  return groups;
}

function parseItems(raw) {
  try {
    const items = JSON.parse(raw || '[]');
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/**
 * Write one movement and the stock change it describes, atomically.
 *
 * The row is locked first so two shops' syncs selling the same colour at the
 * same moment take from each other's result, not from the same starting number.
 *
 * @returns {Promise<boolean>} false when this order line already has this movement
 */
async function applyMovement({ productId, kind, storeId, orderId, itemId, modelId, change }) {
  try {
    await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw`SELECT stock FROM products WHERE id = ${productId} FOR UPDATE`;
      if (!row) return;

      let next;
      let delta;
      let note = null;
      if (change < 0) {
        const take = planTake(row.stock, -change);
        next = take.next;
        delta = take.delta;
        if (take.short > 0) note = `stok kurang ${take.short}, diisi 0`;
      } else {
        next = row.stock + change;
        delta = change;
      }

      // Created before the stock moves: the unique key is what stops a second
      // sync from taking the same order twice, and it has to fail first.
      await tx.stockMovement.create({
        data: { productId, kind, delta, stockAfter: next, storeId, orderId, itemId, modelId, note },
      });
      await tx.product.update({ where: { id: productId }, data: { stock: next } });
    });
    return true;
  } catch (err) {
    if (err.code === 'P2002') return false;
    throw err;
  }
}

/**
 * Take stock for this store's paid orders that have not been counted yet.
 *
 * @returns {Promise<{ orders: number, lines: number, productIds: Set<string> }>}
 */
async function countPaidOrders(storeId, since) {
  const rows = await prisma.order.findMany({
    where: { storeId, stockCountedAt: null, status: { in: PAID_STATUSES }, orderDate: { gte: since } },
    select: { id: true, orderId: true, items: true },
  });
  const productIds = new Set();
  if (rows.length === 0) return { orders: 0, lines: 0, productIds };

  const listings = await prisma.productListing.findMany({
    where: { storeId, productId: { not: null } },
    select: { itemId: true, modelId: true, productId: true },
  });
  const masterOf = new Map(listings.map(l => [`${l.itemId}::${l.modelId}`, l.productId]));

  let lines = 0;
  const groups = byOrder(rows);
  for (const [orderId, orderRows] of groups) {
    for (const line of orderLines(orderRows.map(r => parseItems(r.items)))) {
      // Not mapped to a master: nothing to take from, now or later. Mapping it
      // afterwards does not reach back — the order is marked counted below.
      const productId = masterOf.get(`${line.itemId}::${line.modelId}`);
      if (!productId) continue;

      const applied = await applyMovement({
        productId, kind: 'ORDER', storeId, orderId,
        itemId: line.itemId, modelId: line.modelId, change: -line.quantity,
      });
      if (applied) {
        lines++;
        productIds.add(productId);
      }
    }

    await prisma.order.updateMany({
      where: { id: { in: orderRows.map(r => r.id) } },
      data: { stockCountedAt: new Date() },
    });
  }

  return { orders: groups.size, lines, productIds };
}

/**
 * Remember which counted orders have shipped, so a cancel that comes after —
 * a failed delivery, a COD refusal — is treated as the return it is.
 */
async function markShipped(storeId) {
  await prisma.order.updateMany({
    where: {
      storeId,
      stockCountedAt: { not: null },
      stockShippedAt: null,
      OR: [
        { status: { in: SHIPPED_STATUSES } },
        { logisticsStatus: { in: SHIPPED_LOGISTICS } },
      ],
    },
    data: { stockShippedAt: new Date() },
  });
}

/**
 * Give back what cancelled orders took, unless they had shipped.
 *
 * Gives back exactly what the ORDER movement took — less than the quantity
 * when stock had run out — so a cancel can never mint stock that was not there.
 *
 * @returns {Promise<{ orders: number, lines: number, returned: number, productIds: Set<string> }>}
 */
async function releaseCancelledOrders(storeId, since) {
  // Only orders counted since the switch was last turned on. One counted in an
  // earlier run and cancelled while it was off is already reflected in the
  // stock opname that preceded switching back on; giving it back would count
  // it twice.
  const rows = await prisma.order.findMany({
    where: { storeId, status: 'CANCELLED', stockCountedAt: { gte: since }, stockReleasedAt: null },
    select: { id: true, orderId: true, status: true, logisticsStatus: true, stockShippedAt: true },
  });
  const productIds = new Set();
  if (rows.length === 0) return { orders: 0, lines: 0, returned: 0, productIds };

  let lines = 0;
  let returned = 0;
  const groups = byOrder(rows);
  for (const [orderId, orderRows] of groups) {
    if (hasShipped(orderRows)) {
      returned++;
    } else {
      const taken = await prisma.stockMovement.findMany({
        where: { storeId, orderId, kind: 'ORDER' },
        select: { productId: true, itemId: true, modelId: true, delta: true },
      });
      for (const t of taken) {
        if (t.delta === 0) continue;
        const applied = await applyMovement({
          productId: t.productId, kind: 'CANCEL', storeId, orderId,
          itemId: t.itemId, modelId: t.modelId, change: -t.delta,
        });
        if (applied) {
          lines++;
          productIds.add(t.productId);
        }
      }
    }

    await prisma.order.updateMany({
      where: { id: { in: orderRows.map(r => r.id) } },
      data: { stockReleasedAt: new Date() },
    });
  }

  return { orders: groups.size, lines, returned, productIds };
}

/**
 * The whole stok otomatis pass for one store. Called after its order sync.
 *
 * Does nothing while the feature is off. Never throws into the sync that called
 * it: a stock problem must not mark an order sync as failed.
 */
async function applyOrderStock(storeId) {
  try {
    const since = await getAutoDeductSince();
    if (!since) return null;

    const counted = await countPaidOrders(storeId, since);
    await markShipped(storeId);
    const released = await releaseCancelledOrders(storeId, since);

    const changed = [...new Set([...counted.productIds, ...released.productIds])];
    let push = null;
    if (changed.length > 0) {
      push = await pushMasterStock(changed);
      for (const f of push.failed) {
        console.warn(`[orderStock] Push failed — ${f.store}: ${f.name} (${f.reason})`);
      }
    }

    if (counted.lines > 0 || released.lines > 0 || released.returned > 0) {
      console.log(
        `[orderStock] Store ${storeId}: ${counted.lines} line(s) taken from ${counted.orders} order(s), ` +
        `${released.lines} line(s) given back, ${released.returned} cancelled after shipping (left as return), ` +
        `${changed.length} master(s) changed` +
        (push ? `, pushed to ${push.pushed} listing(s), ${push.failed.length} failed` : '')
      );
    }

    return { counted, released, push };
  } catch (err) {
    console.error(`[orderStock] Store ${storeId} failed:`, err);
    return null;
  }
}

module.exports = {
  applyOrderStock,
  getAutoDeductSince,
  setAutoDeduct,
  // Exported for testing
  orderLines,
  hasShipped,
  planTake,
  normaliseModelId,
  PAID_STATUSES,
};
