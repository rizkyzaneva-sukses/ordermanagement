'use strict';

const express = require('express');
const prisma = require('../prisma/client');
const { authenticate } = require('../middleware/auth');
const { orderMerchandiseValue } = require('../services/orderValue');
const { orderDateRange } = require('../utils/dateRange');

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

    const orderDate = orderDateRange(dateFrom, dateTo);
    if (orderDate) where.orderDate = orderDate;

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
      } else if (store.lastSyncStatus === 'PARTIAL') {
        // Finished, but a status pass was lost — its orders went unrefreshed
        status = 'PARTIAL';
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
