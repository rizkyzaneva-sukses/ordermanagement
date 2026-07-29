const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client.js');
const { syncQueue, isRedisReady, hasQueueWorkers } = require('../services/queue.js');
const { authenticate } = require('../middleware/auth.js');
const pdfService = require('../services/pdf.js');
const fulfillmentService = require('../services/fulfillment.js');

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

    // ── Queue the work only if something is actually listening ────────────────
    //
    // Enqueuing with no worker running looks identical to success from here: the
    // job sits in Redis untouched and the user sees an empty order list. So the
    // presence of a consumer is checked, not just the presence of Redis.
    const workersAvailable = await hasQueueWorkers(syncQueue);

    if (workersAvailable) {
      for (const sid of storeIds) {
        await syncQueue.add('sync-store', { storeId: sid }, { removeOnComplete: true });
      }
      console.log(`[orders/sync] Queued ${storeIds.length} store(s) to the sync worker`);
      return res.json({
        success: true,
        data: {
          message: `Sync untuk ${storeIds.length} toko dimasukkan ke antrean`,
          mode: 'queued',
          storesQueued: storeIds.length,
        },
      });
    }

    // ── No worker (or no Redis) → run in-process ──────────────────────────────
    console.warn(
      isRedisReady()
        ? '[orders/sync] Redis is up but no sync worker is running — syncing in-process. Start it with `npm run worker`.'
        : '[orders/sync] Redis unavailable — syncing in-process.'
    );

    const { syncStore } = require('../services/syncDirect.js');

    // Answer before the work finishes so the request cannot time out on a slow
    // marketplace; the per-store outcome is persisted and read back via
    // GET /orders/sync-status.
    res.json({
      success: true,
      data: {
        message: `Sync untuk ${storeIds.length} toko sedang berjalan`,
        mode: 'inline',
        workerMissing: isRedisReady(),
        storesQueued: storeIds.length,
      },
    });

    for (const sid of storeIds) {
      try {
        await syncStore(sid);
      } catch (syncErr) {
        // Already recorded on the store row by syncStore
        console.error(`[orders/sync] In-process sync failed for store ${sid}:`, syncErr.message);
      }
    }
  } catch (err) {
    console.error('POST /orders/sync error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'Failed to trigger sync' });
    }
  }
});

/**
 * GET /sync-status - Per-store outcome of the most recent sync
 *
 * Lets the UI distinguish "this shop has no orders" from "this shop's sync is
 * broken", and point at the shops that need re-authorizing.
 */
router.get('/sync-status', async (req, res) => {
  try {
    const user = req.user;
    const where = { isActive: true };

    if (user.role === 'STAFF') {
      const access = await prisma.storeAccess.findMany({
        where: { userId: user.id },
        select: { storeId: true },
      });
      where.id = { in: access.map((a) => a.storeId) };
    }

    const stores = await prisma.store.findMany({
      where,
      select: {
        id: true,
        name: true,
        platform: true,
        lastSyncAt: true,
        lastSyncAttemptAt: true,
        lastSyncStatus: true,
        lastSyncError: true,
        needsReconnect: true,
      },
      orderBy: { name: 'asc' },
    });

    const workerRunning = await hasQueueWorkers(syncQueue);

    return res.json({
      success: true,
      data: {
        stores,
        failing: stores.filter((s) => s.lastSyncStatus === 'ERROR').length,
        needsReconnect: stores.filter((s) => s.needsReconnect).length,
        redisReady: isRedisReady(),
        workerRunning,
      },
    });
  } catch (err) {
    console.error('GET /orders/sync-status error:', err);
    return res.status(500).json({ success: false, error: 'Failed to get sync status' });
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

    const notPrintable = orders
      .map((o) => ({ order: o, check: fulfillmentService.checkAwbPrintable(o) }))
      .filter((x) => !x.check.ok);

    if (notPrintable.length > 0) {
      return res.status(400).json({
        success: false,
        error: `${notPrintable.length} order(s) cannot be selected: ` +
          notPrintable.map((x) => `${x.order.orderId} (${x.check.reason})`).join(', '),
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
        // A split order yields several rows sharing one orderId; the package
        // number is what tells them apart on the packing bench.
        packageNumber: o.packageNumber || '',
        logisticsStatus: o.logisticsStatus || null,
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

    // Validate: still inside the label printing window (KB §7.3). Skipped for
    // an explicit reprint of labels already issued.
    if (!reprint) {
      const notPrintable = orders
        .map((o) => ({ order: o, check: fulfillmentService.checkAwbPrintable(o) }))
        .filter((x) => !x.check.ok);

      if (notPrintable.length > 0) {
        return res.status(400).json({
          success: false,
          error: `${notPrintable.length} order(s) cannot be printed: ` +
            notPrintable.map((x) => `${x.order.orderId} (${x.check.reason})`).join(', '),
        });
      }
    }

    // Parse items for each order
    const ordersWithItems = orders.map((o) => {
      let items = o.items;
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch { items = []; }
      }
      return { ...o, items: Array.isArray(items) ? items : [] };
    });

    // Enrich with Shopee's own AWB routing data where available (KB §5 step 7a)
    const awbDataMap = await fulfillmentService.fetchAwbDataForRows(orders);

    // Generate batch PDF
    const pdfBuffer = await pdfService.generateBatchPdf(ordersWithItems, awbDataMap);

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

// ── Fulfillment (Shopee write operations) ─────────────────────────────────────
//
// Every handler below reaches out to Shopee and re-reads the live order before
// acting (KB Rule #1), so they are deliberately not batched into the generic
// update endpoints.

/**
 * Confirm the caller may act on this order row, and return it.
 * STAFF are limited to the stores they have been granted.
 */
async function loadAccessibleOrder(user, orderRowId) {
  const order = await prisma.order.findUnique({
    where: { id: orderRowId },
    select: { id: true, storeId: true, orderId: true },
  });

  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  if (user.role === 'STAFF') {
    const access = await prisma.storeAccess.findFirst({
      where: { userId: user.id, storeId: order.storeId },
    });
    if (!access) {
      const err = new Error('No access to this store');
      err.statusCode = 403;
      throw err;
    }
  }

  return order;
}

/** Same check for a set of rows, used by the batch endpoints. */
async function assertAccessibleOrders(user, orderRowIds) {
  if (user.role !== 'STAFF') return;

  const rows = await prisma.order.findMany({
    where: { id: { in: orderRowIds } },
    select: { storeId: true },
  });

  const access = await prisma.storeAccess.findMany({
    where: { userId: user.id },
    select: { storeId: true },
  });
  const allowed = new Set(access.map(a => a.storeId));

  const denied = rows.filter(r => !allowed.has(r.storeId));
  if (denied.length > 0) {
    const err = new Error(`No access to ${denied.length} of the selected order(s)`);
    err.statusCode = 403;
    throw err;
  }
}

/**
 * Wrap a fulfillment handler so service-level errors keep their intended HTTP
 * status instead of collapsing into a generic 500.
 */
function fulfillmentRoute(label, handler) {
  return async (req, res) => {
    try {
      const data = await handler(req);
      return res.json({ success: true, data });
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) console.error(`${label} error:`, err);
      else console.warn(`${label} rejected: ${err.message}`);
      return res.status(status).json({ success: false, error: err.message || label + ' failed' });
    }
  };
}

/**
 * POST /ship-mass - Arrange shipment for many packages at once
 * Body: { ids: string[], mode?, modeData? }
 */
router.post('/ship-mass', fulfillmentRoute('Mass ship', async (req) => {
  const { ids, mode, modeData } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    const err = new Error('ids must be a non-empty array');
    err.statusCode = 400;
    throw err;
  }
  await assertAccessibleOrders(req.user, ids);
  return fulfillmentService.massArrangeShipment(ids, { mode, modeData, userId: req.user.id });
}));

/**
 * GET /:id/shipping-options - Modes, pickup addresses and time slots
 */
router.get('/:id/shipping-options', fulfillmentRoute('Shipping options', async (req) => {
  await loadAccessibleOrder(req.user, req.params.id);
  return fulfillmentService.getShippingOptions(req.params.id);
}));

/**
 * POST /:id/ship - Arrange shipment for one package
 * Body: { mode?, modeData? }
 */
router.post('/:id/ship', fulfillmentRoute('Ship', async (req) => {
  await loadAccessibleOrder(req.user, req.params.id);
  const { mode, modeData } = req.body || {};
  return fulfillmentService.arrangeShipment(req.params.id, { mode, modeData, userId: req.user.id });
}));

/**
 * POST /:id/retry-ship - Re-arrange a failed pickup (status RETRY_SHIP)
 * Body: { addressId, pickupTimeId }
 */
router.post('/:id/retry-ship', fulfillmentRoute('Retry ship', async (req) => {
  await loadAccessibleOrder(req.user, req.params.id);
  const { addressId, pickupTimeId } = req.body || {};
  return fulfillmentService.retryShipment(req.params.id, { addressId, pickupTimeId });
}));

/**
 * POST /:id/cancel - Seller-initiated cancellation
 * Body: { reason: 'OUT_OF_STOCK' | 'UNDELIVERABLE_AREA', itemList? }
 */
router.post('/:id/cancel', fulfillmentRoute('Cancel', async (req) => {
  await loadAccessibleOrder(req.user, req.params.id);
  const { reason, itemList } = req.body || {};
  return fulfillmentService.cancelOrder(req.params.id, { reason, itemList });
}));

/**
 * POST /:id/handle-cancellation - Approve or reject a buyer's cancel request
 * Body: { operation: 'ACCEPT' | 'REJECT' }
 */
router.post('/:id/handle-cancellation', fulfillmentRoute('Handle cancellation', async (req) => {
  await loadAccessibleOrder(req.user, req.params.id);
  const { operation } = req.body || {};
  return fulfillmentService.respondToCancellation(req.params.id, operation);
}));

/**
 * GET /:id/split-options - Items and the grouping rules limiting a split
 */
router.get('/:id/split-options', fulfillmentRoute('Split options', async (req) => {
  await loadAccessibleOrder(req.user, req.params.id);
  return fulfillmentService.getSplitOptions(req.params.id);
}));

/**
 * POST /:id/split - Divide the order into packages
 * Body: { packages: [{ items: [{ itemId, modelId, orderItemId, promotionGroupId, addOnDealId }] }] }
 */
router.post('/:id/split', fulfillmentRoute('Split order', async (req) => {
  await loadAccessibleOrder(req.user, req.params.id);
  const { packages } = req.body || {};
  return fulfillmentService.splitOrder(req.params.id, packages);
}));

/**
 * POST /:id/unsplit - Merge a split order back into one package
 */
router.post('/:id/unsplit', fulfillmentRoute('Unsplit order', async (req) => {
  await loadAccessibleOrder(req.user, req.params.id);
  return fulfillmentService.unsplitOrder(req.params.id);
}));

/**
 * POST /:id/refresh-tracking - Pull the tracking number on demand
 */
router.post('/:id/refresh-tracking', fulfillmentRoute('Refresh tracking', async (req) => {
  await loadAccessibleOrder(req.user, req.params.id);
  return fulfillmentService.refreshTracking(req.params.id);
}));

/**
 * GET /:id/tracking-info - 3PL event history
 */
router.get('/:id/tracking-info', fulfillmentRoute('Tracking info', async (req) => {
  await loadAccessibleOrder(req.user, req.params.id);
  return fulfillmentService.getTrackingEvents(req.params.id);
}));

module.exports = router;
