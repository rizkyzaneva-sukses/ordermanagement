'use strict';

const express = require('express');
const prisma = require('../prisma/client');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

/**
 * GET /stats - Summary counts of orders
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

    const [pending, processing, shipped, cancelled] = await Promise.all([
      prisma.order.count({ where: { ...where, status: 'PENDING' } }),
      prisma.order.count({ where: { ...where, status: 'PROCESSING' } }),
      prisma.order.count({ where: { ...where, status: 'SHIPPED' } }),
      prisma.order.count({ where: { ...where, status: 'CANCELLED' } }),
    ]);

    return res.json({
      success: true,
      data: { pending, processing, shipped, cancelled },
    });
  } catch (err) {
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

    const stores = await prisma.store.findMany({
      where,
      include: { _count: { select: { orders: true } } },
    });

    const data = stores.map((store) => ({
      id: store.id,
      name: store.name,
      platform: store.platform,
      orderCount: store._count.orders,
      status: 'ACTIVE',
    }));

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch dashboard stores' });
  }
});

module.exports = router;
