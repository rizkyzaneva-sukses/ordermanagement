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
