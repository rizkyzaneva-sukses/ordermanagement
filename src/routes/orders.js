const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client.js');
const { syncQueue, isRedisReady } = require('../services/queue.js');
const { authenticate } = require('../middleware/auth.js');
const pdfService = require('../services/pdf.js');

// All order routes require auth
router.use(authenticate);

/**
 * GET / - List orders with filters
 */
router.get('/', async (req, res) => {
  try {
    const user = req.user;
    const {
      storeId,
      platform,
      status,
      shippingCourier,
      dateFrom,
      dateTo,
      search,
      page = 1,
      limit = 50,
      printFilter = 'unprinted',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    // Build where clause
    const where = {};

    // Store access restriction for STAFF
    if (user.role === 'STAFF') {
      const access = await prisma.storeAccess.findMany({
        where: { userId: user.id },
        select: { storeId: true },
      });
      const accessibleStoreIds = access.map((a) => a.storeId);
      if (storeId) {
        if (!accessibleStoreIds.includes(storeId)) {
          return res.status(403).json({ success: false, error: 'No access to this store' });
        }
        where.storeId = storeId;
      } else {
        where.storeId = { in: accessibleStoreIds };
      }
    } else if (storeId) {
      where.storeId = storeId;
    }

    // Platform filter (via store relation)
    if (platform) {
      where.store = { platform: platform };
    }

    if (status) {
      where.status = status;
    }

    if (shippingCourier) {
      where.shippingCourier = { contains: shippingCourier, mode: 'insensitive' };
    }

    if (dateFrom || dateTo) {
      where.orderDate = {};
      if (dateFrom) where.orderDate.gte = new Date(dateFrom);
      if (dateTo) where.orderDate.lte = new Date(dateTo);
    }

    if (search) {
      where.OR = [
        { orderId: { contains: search, mode: 'insensitive' } },
        { buyerName: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Print filter logic — accept both English ('unprinted'/'printed') and
    // Indonesian ('belum'/'sudah') values sent by the frontend
    if (printFilter === 'unprinted' || printFilter === 'belum') {
      where.printedAt = null;
      where.trackingNumber = { not: null };
    } else if (printFilter === 'printed' || printFilter === 'sudah') {
      where.printedAt = { not: null };
    }
    // 'all' / 'semua' → no printedAt filter

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          store: { select: { id: true, name: true, platform: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.order.count({ where }),
    ]);

    // Get counts for tabs
    const baseFilter = user.role === 'STAFF' ? {
      storeId: { in: (await prisma.storeAccess.findMany({ where: { userId: user.id }, select: { storeId: true } })).map(a => a.storeId) }
    } : {};

    const [unprintedCount, printedCount] = await Promise.all([
      prisma.order.count({ where: { ...baseFilter, printedAt: null, trackingNumber: { not: null } } }),
      prisma.order.count({ where: { ...baseFilter, printedAt: { not: null } } }),
    ]);

    return res.json({
      success: true,
      data: {
        orders,
        total,
        page: pageNum,
        limit: limitNum,
        counts: {
          unprinted: unprintedCount,
          printed: printedCount,
          all: unprintedCount + printedCount,
        },
      },
    });
  } catch (err) {
    console.error('GET /orders error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list orders' });
  }
});

/**
 * GET /stats - Order counts by status for dashboard
 */
router.get('/stats', async (req, res) => {
  try {
    const user = req.user;
    const where = {};

    if (user.role === 'STAFF') {
      const access = await prisma.storeAccess.findMany({
        where: { userId: user.id },
        select: { storeId: true },
      });
      where.storeId = { in: access.map((a) => a.storeId) };
    }

    const grouped = await prisma.order.groupBy({
      by: ['status'],
      where,
      _count: { id: true },
    });

    const stats = {};
    for (const row of grouped) {
      stats[row.status] = row._count.id;
    }

    return res.json({ success: true, data: stats });
  } catch (err) {
    console.error('GET /orders/stats error:', err);
    return res.status(500).json({ success: false, error: 'Failed to get order stats' });
  }
});

/**
 * POST /sync - Manual sync trigger
 */
router.post('/sync', async (req, res) => {
  try {
    const user = req.user;
    const { storeId } = req.body;

    let storeIds = [];

    if (storeId) {
      if (user.role === 'STAFF') {
        const access = await prisma.storeAccess.findMany({
          where: { userId: user.id, storeId },
          select: { storeId: true },
        });
        if (access.length === 0) {
          return res.status(403).json({ success: false, error: 'No access to this store' });
        }
      }
      storeIds = [storeId];
    } else {
      if (user.role === 'STAFF') {
        const access = await prisma.storeAccess.findMany({
          where: { userId: user.id },
          select: { storeId: true },
        });
        storeIds = access.map((a) => a.storeId);
      } else {
        const stores = await prisma.store.findMany({ where: { isActive: true }, select: { id: true } });
        storeIds = stores.map((s) => s.id);
      }
    }

    if (storeIds.length === 0) {
      return res.json({ success: true, data: { message: 'No stores to sync', storesQueued: 0 } });
    }

    // ── Redis available → enqueue via BullMQ ──────────────────────────────────
    if (isRedisReady()) {
      for (const sid of storeIds) {
        await syncQueue.add('sync-store', { storeId: sid }, { removeOnComplete: true });
      }
      return res.json({
        success: true,
        data: { message: `Queued sync for ${storeIds.length} store(s)`, storesQueued: storeIds.length },
      });
    }

    // ── Redis unavailable → run sync directly (in-process fallback) ───────────
    console.warn('[orders/sync] Redis not available — running sync directly in-process');
    const { syncStore } = require('../services/syncDirect.js');

    // Respond immediately so the HTTP request doesn't hang
    res.json({
      success: true,
      data: { message: `Running direct sync for ${storeIds.length} store(s) (Redis unavailable)`, storesQueued: storeIds.length },
    });

    for (const sid of storeIds) {
      try {
        await syncStore(sid);
      } catch (syncErr) {
        console.error(`[orders/sync] Direct sync failed for store ${sid}:`, syncErr.message);
      }
    }


  } catch (err) {
    console.error('POST /orders/sync error:', err);
    return res.status(500).json({ success: false, error: 'Failed to trigger sync' });
  }
});

/**
 * POST /batch-select - Select orders for batch printing
 */
router.post('/batch-select', async (req, res) => {
  try {
    const { orderIds } = req.body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ success: false, error: 'orderIds array is required' });
    }

    if (orderIds.length > 300) {
      return res.status(400).json({ success: false, error: 'Maximum 300 orders per batch' });
    }

    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      include: { store: { select: { platform: true } } },
    });

    if (orders.length !== orderIds.length) {
      return res.status(400).json({ success: false, error: 'Some orders not found' });
    }

    const noTracking = orders.filter((o) => !o.trackingNumber);
    if (noTracking.length > 0) {
      return res.status(400).json({
        success: false,
        error: `${noTracking.length} order(s) missing tracking number`,
      });
    }

    const alreadyPrinted = orders.filter((o) => o.printedAt !== null);
    if (alreadyPrinted.length > 0) {
      return res.status(400).json({
        success: false,
        error: `${alreadyPrinted.length} order(s) already printed`,
      });
    }

    // All must be same platform (via store)
    const platforms = [...new Set(orders.map((o) => o.store?.platform).filter(Boolean))];
    if (platforms.length > 1) {
      return res.status(400).json({
        success: false,
        error: 'All orders must be from the same platform',
      });
    }

    await prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: { isBatchSelected: true },
    });

    return res.json({
      success: true,
      data: { selected: orderIds.length, platform: platforms[0] },
    });
  } catch (err) {
    console.error('POST /orders/batch-select error:', err);
    return res.status(500).json({ success: false, error: 'Failed to select orders' });
  }
});

/**
 * DELETE /batch-select - Clear batch selection
 */
router.delete('/batch-select', async (req, res) => {
  try {
    const user = req.user;
    const where = { isBatchSelected: true };

    if (user.role === 'STAFF') {
      const access = await prisma.storeAccess.findMany({
        where: { userId: user.id },
        select: { storeId: true },
      });
      where.storeId = { in: access.map((a) => a.storeId) };
    }

    const result = await prisma.order.updateMany({
      where,
      data: { isBatchSelected: false },
    });

    return res.json({ success: true, data: { cleared: result.count } });
  } catch (err) {
    console.error('DELETE /orders/batch-select error:', err);
    return res.status(500).json({ success: false, error: 'Failed to clear selection' });
  }
});

/**
 * POST /print-details
 * Return full order details for a list of IDs (used by the /print page).
 * Body: { ids: string[] }
 */
router.post('/print-details', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    }

    const orders = await prisma.order.findMany({
      where: { id: { in: ids } },
      include: { store: { select: { id: true, name: true, platform: true } } },
    });

    const data = orders.map((o) => {
      let items = o.items;
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch { items = []; }
      }
      return {
        id: o.id,
        orderId: o.orderId,
        storeId: o.storeId,
        storeName: o.store?.name || 'Toko',
        platform: o.store?.platform || 'SHOPEE',
        buyerName: o.buyerName,
        buyerAddress: o.buyerAddress,
        buyerPhone: o.buyerPhone,
        buyerCity: o.buyerCity,
        buyerProvince: o.buyerProvince,
        buyerPostalCode: o.buyerPostalCode,
        courier: o.shippingCourier,
        trackingNumber: o.trackingNumber || '',
        status: o.status,
        printedAt: o.printedAt,
        items: Array.isArray(items) ? items.map((item) => ({
          name: item.name || item.item_name || 'Product',
          qty: item.quantity || item.qty || 1,
          variant: item.variant || undefined,
          price: item.price,
        })) : [],
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error('POST /orders/print-details error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch print details' });
  }
});

/**
 * POST /print
 * Generate a batch PDF for the given order IDs and return it as a blob.
 * Body: { ids: string[], reprint?: boolean }
 */
router.post('/print', async (req, res) => {
  try {
    const { ids, reprint } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    }
    if (ids.length > 300) {
      return res.status(400).json({ success: false, error: 'Maximum 300 orders per print batch' });
    }

    const orders = await prisma.order.findMany({
      where: { id: { in: ids } },
      include: { store: true },
    });

    if (orders.length === 0) {
      return res.status(404).json({ success: false, error: 'No orders found' });
    }

    // Validate: all orders must have tracking numbers
    const noTracking = orders.filter((o) => !o.trackingNumber);
    if (noTracking.length > 0 && !reprint) {
      return res.status(400).json({
        success: false,
        error: `${noTracking.length} order(s) missing tracking number`,
      });
    }

    // Parse items for each order
    const ordersWithItems = orders.map((o) => {
      let items = o.items;
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch { items = []; }
      }
      return { ...o, items: Array.isArray(items) ? items : [] };
    });

    // Generate batch PDF
    const pdfBuffer = await pdfService.generateBatchPdf(ordersWithItems);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="resi-${new Date().toISOString().slice(0, 10)}.pdf"`);
    return res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('POST /orders/print error:', err);
    return res.status(500).json({ success: false, error: 'Failed to generate PDF' });
  }
});

/**
 * POST /mark-printed
 * Mark a list of orders as printed.
 * Body: { ids: string[] }
 */
router.post('/mark-printed', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    }

    await prisma.order.updateMany({
      where: { id: { in: ids } },
      data: {
        printedAt: new Date(),
        printedById: req.user.id,
      },
    });

    return res.json({ success: true, data: { marked: ids.length } });
  } catch (err) {
    console.error('POST /orders/mark-printed error:', err);
    return res.status(500).json({ success: false, error: 'Failed to mark orders as printed' });
  }
});

module.exports = router;
