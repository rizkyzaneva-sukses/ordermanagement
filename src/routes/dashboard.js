'use strict';

const express = require('express');
const prisma = require('../prisma/client');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

/**
 * Operational buckets, expressed in the statuses the platforms actually return.
 *
 * The previous version counted `PENDING` and `PROCESSING`, which Shopee never
 * emits (its enum is in KB §2.1), so those tiles always read zero.
 */
const STAT_BUCKETS = {
  toShip:         ['READY_TO_SHIP'],
  awaitingPickup: ['PROCESSED'],
  shipped:        ['SHIPPED', 'TO_CONFIRM_RECEIVE'],
  // Both need a human: a failed pickup must be re-arranged, and an unanswered
  // buyer cancellation is auto-approved once the window closes (KB §2.2).
  needsAttention: ['RETRY_SHIP', 'IN_CANCEL'],
  cancelled:      ['CANCELLED'],
  unpaid:         ['UNPAID'],
  completed:      ['COMPLETED'],
};

/**
 * GET /stats - Summary counts of packages by operational bucket
 */
router.get('/stats', async (req, res) => {
  try {
    const user = req.user;
    let where = {};
    if (user.role === 'STAFF') {
      const access = await prisma.storeAccess.findMany({
        where: { userId: user.id },
        select: { storeId: true },
      });
      where.storeId = { in: access.map((a) => a.storeId) };
    }

    // One grouped query instead of one COUNT per bucket
    const grouped = await prisma.order.groupBy({
      by: ['status'],
      where,
      _count: { id: true },
    });

    const byStatus = {};
    for (const row of grouped) byStatus[row.status] = row._count.id;

    const data = {};
    for (const [bucket, statuses] of Object.entries(STAT_BUCKETS)) {
      data[bucket] = statuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);
    }

    // Raw per-status counts, so a status we have not bucketed is still visible
    data.byStatus = byStatus;

    return res.json({ success: true, data });
  } catch (err) {
    console.error('GET /dashboard/stats error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch dashboard stats' });
  }
});

/**
 * Merchandise value of one order, from the item lines stored on its rows.
 *
 * There is no order-total column — the only money in the schema is `price` and
 * `quantity` inside the `items` JSON — so this is the item subtotal: shipping
 * fees, vouchers and platform discounts are not in it.
 *
 * Items are de-duplicated across the order's package rows. When Shopee returns
 * a package without its own `item_list`, the sync falls back to writing the
 * whole order's items onto every package (see expandShopeeOrderToPackages), so
 * summing rows blindly would count a split order two or three times over.
 * De-duplicating by item+model is safe in both cases: KB §6 rule 4 forbids
 * splitting identical item+model across packages, so a genuine split never
 * repeats a pair either.
 *
 * @param {Array<{items: string}>} rows - Every package row of one order
 * @returns {number}
 */
function orderMerchandiseValue(rows) {
  const seen = new Set();
  let total = 0;

  for (const row of rows) {
    let items;
    try {
      items = JSON.parse(row.items || '[]');
    } catch {
      continue; // a malformed row must not take the whole panel down
    }
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      // TikTok rows carry no itemId, so fall back to something stable-ish
      const key = item.itemId != null
        ? `${item.itemId}::${item.modelId ?? 0}`
        : `${item.name || ''}::${item.price ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);

      total += (Number(item.price) || 0) * (Number(item.quantity) || 1);
    }
  }

  return total;
}

/**
 * GET /statistics - Order value and counts over a date range
 *
 * Query: dateFrom, dateTo (YYYY-MM-DD), platform, storeId
 *
 * Counts are per order, not per package: a split order is one order here even
 * though it occupies several rows.
 */
router.get('/statistics', async (req, res) => {
  try {
    const user = req.user;
    const { dateFrom, dateTo, platform, storeId } = req.query;

    const where = {};

    if (user.role === 'STAFF') {
      const access = await prisma.storeAccess.findMany({
        where: { userId: user.id },
        select: { storeId: true },
      });
      const allowed = access.map((a) => a.storeId);
      // A staff member asking for one store still only gets it if it is theirs
      where.storeId = storeId
        ? { in: allowed.filter((id) => id === storeId) }
        : { in: allowed };
    } else if (storeId) {
      where.storeId = storeId;
    }

    if (platform) where.store = { platform };

    if (dateFrom || dateTo) {
      where.orderDate = {};
      if (dateFrom) where.orderDate.gte = new Date(`${dateFrom}T00:00:00`);
      // The picker sends a day, and a day means through its last second
      if (dateTo) where.orderDate.lte = new Date(`${dateTo}T23:59:59.999`);
    }

    const rows = await prisma.order.findMany({
      where,
      select: { orderId: true, status: true, items: true },
    });

    // Collapse packages back into orders
    const byOrder = new Map();
    for (const row of rows) {
      if (!byOrder.has(row.orderId)) byOrder.set(row.orderId, { status: row.status, rows: [] });
      byOrder.get(row.orderId).rows.push(row);
    }

    const inBucket = (status, bucket) => STAT_BUCKETS[bucket].includes(status);

    let totalValue = 0;
    let completedValue = 0;
    let cancelledValue = 0;
    let readyToShipCount = 0;
    let shippedCount = 0;
    let cancelledCount = 0;
    let completedCount = 0;

    for (const order of byOrder.values()) {
      const value = orderMerchandiseValue(order.rows);
      totalValue += value;

      if (inBucket(order.status, 'completed')) {
        completedCount++;
        completedValue += value;
      }
      if (inBucket(order.status, 'cancelled')) {
        cancelledCount++;
        cancelledValue += value;
      }
      if (inBucket(order.status, 'toShip')) readyToShipCount++;
      if (inBucket(order.status, 'shipped')) shippedCount++;
    }

    const orderCount = byOrder.size;

    return res.json({
      success: true,
      data: {
        orderCount,
        packageCount: rows.length,
        readyToShipCount,
        shippedCount,
        cancelledCount,
        completedCount,
        totalValue,
        completedValue,
        cancelledValue,
        averageOrderValue: orderCount > 0 ? Math.round(totalValue / orderCount) : 0,
        // Tells the UI not to present these as settlement figures
        valueBasis: 'ITEM_SUBTOTAL',
      },
    });
  } catch (err) {
    console.error('GET /dashboard/statistics error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /stores - Store statuses and order counts
 */
router.get('/stores', async (req, res) => {
  try {
    const user = req.user;
    let where = { isActive: true };
    if (user.role === 'STAFF') {
      const access = await prisma.storeAccess.findMany({
        where: { userId: user.id },
        select: { storeId: true },
      });
      where.id = { in: access.map((a) => a.storeId) };
    }

    const stores = await prisma.store.findMany({ where });

    // An `orders` row is a package, so the relation count would overstate the
    // number of orders for any shop with split parcels. Count both.
    const tallies = await prisma.$queryRaw`
      SELECT "storeId",
             COUNT(DISTINCT "orderId")::int AS "orderCount",
             COUNT(*)::int                  AS "packageCount"
      FROM "orders"
      GROUP BY "storeId"
    `;

    const byStore = new Map(tallies.map((t) => [t.storeId, t]));

    const data = stores.map((store) => {
      const tally = byStore.get(store.id);

      // Was hardcoded to ACTIVE, so a shop whose token had expired still looked
      // healthy — the one case where the badge actually needs to say something.
      let status = 'ACTIVE';
      if (store.needsReconnect) {
        status = 'EXPIRED';
      } else if (store.lastSyncStatus === 'ERROR') {
        status = 'ERROR';
      }

      return {
        id: store.id,
        name: store.name,
        platform: store.platform,
        orderCount: tally?.orderCount ?? 0,
        packageCount: tally?.packageCount ?? 0,
        status,
        tokenExpiry: store.tokenExpiry,
        lastSyncAt: store.lastSyncAt,
        lastSyncError: store.lastSyncError,
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch dashboard stores' });
  }
});

module.exports = router;
