const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client.js');
const pdfService = require('../services/pdf.js');
const { printQueue, isRedisReady } = require('../services/queue.js');
const { authenticate } = require('../middleware/auth.js');
const fulfillmentService = require('../services/fulfillment.js');

const MAX_BATCH_SIZE = 300;
// Shopee generates air waybills 50 packages at a time (KB §7)
const MAX_AWB_BATCH_SIZE = 50;

router.use(authenticate);

/**
 * POST /preview - Preview single receipt PDF
 */
router.post('/preview', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, error: 'orderId is required' });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { store: true },
    });

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const awbDataMap = await fulfillmentService.fetchAwbDataForRows([order]);
    const pdfBytes = await pdfService.generateReceipt(
      order,
      awbDataMap.get(`${order.orderId}::${order.packageNumber || ''}`),
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receipt-${orderId}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('Preview error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate preview' });
  }
});

/**
 * POST /batch - Start batch print job
 */
router.post('/batch', async (req, res) => {
  try {
    const { orderIds } = req.body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ success: false, error: 'orderIds must be a non-empty array' });
    }

    if (orderIds.length > MAX_BATCH_SIZE) {
      return res.status(400).json({ success: false, error: `Batch size exceeds maximum of ${MAX_BATCH_SIZE}` });
    }

    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      include: { store: true },
    });

    if (orders.length !== orderIds.length) {
      return res.status(400).json({ success: false, error: 'Some orders not found' });
    }

    // Validate: all unprinted
    const alreadyPrinted = orders.filter((o) => o.printedAt);
    if (alreadyPrinted.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'All orders must be unprinted',
        invalidOrderIds: alreadyPrinted.map((o) => o.id),
      });
    }

    // Validate: still inside the label printing window (KB §7.3) — a package
    // already collected by the 3PL must not get a fresh label.
    const notPrintable = orders
      .map((o) => ({ order: o, check: fulfillmentService.checkAwbPrintable(o) }))
      .filter((x) => !x.check.ok);

    if (notPrintable.length > 0) {
      return res.status(400).json({
        success: false,
        error: `${notPrintable.length} order(s) cannot be printed: ` +
          notPrintable.map((x) => `${x.order.orderId} (${x.check.reason})`).join(', '),
        invalidOrderIds: notPrintable.map((x) => x.order.id),
      });
    }

    // Validate: same platform
    const platforms = new Set(orders.map((o) => o.store?.platform).filter(Boolean));
    if (platforms.size > 1) {
      return res.status(400).json({
        success: false,
        error: 'All orders must be from the same platform',
      });
    }

    const platform = [...platforms][0];
    const storeIds = [...new Set(orders.map((o) => o.storeId))];

    // ── Redis available → async via BullMQ ────────────────────────────────────
    if (isRedisReady()) {
      const batch = await prisma.printBatch.create({
        data: {
          userId: req.user.id,
          platform: platform,
          storeIds: JSON.stringify(storeIds),
          orderCount: orders.length,
          status: 'PENDING',
        },
      });

      await prisma.order.updateMany({
        where: { id: { in: orderIds } },
        data: { isBatchSelected: true, batchId: batch.id },
      });

      await printQueue.add('process-batch', {
        batchId: batch.id,
        orderIds,
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 86400 },
      });

      return res.status(201).json({
        success: true,
        data: { batchId: batch.id, status: batch.status, orderCount: orders.length },
      });
    }

    // ── Redis unavailable → generate PDF inline (synchronous fallback) ────────
    console.warn('[print/batch] Redis not available — generating PDF inline');

    const ordersWithItems = orders.map((o) => {
      let items = o.items;
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch { items = []; }
      }
      return { ...o, items: Array.isArray(items) ? items : [] };
    });

    const awbDataMap = await fulfillmentService.fetchAwbDataForRows(orders);
    const pdfBuffer = await pdfService.generateBatchPdf(ordersWithItems, awbDataMap);

    // Mark orders as printed
    await prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: { printedAt: new Date(), printedById: req.user.id },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="batch-${Date.now()}.pdf"`);
    return res.send(Buffer.from(pdfBuffer));

  } catch (err) {
    console.error('Batch error:', err);
    res.status(500).json({ success: false, error: 'Failed to create batch' });
  }
});


/**
 * GET /batch/:id/status - Batch progress
 */
router.get('/batch/:id/status', async (req, res) => {
  try {
    const batch = await prisma.printBatch.findUnique({
      where: { id: req.params.id },
    });

    if (!batch) {
      return res.status(404).json({ success: false, error: 'Batch not found' });
    }

    // Count orders in this batch
    const processedCount = await prisma.order.count({
      where: { batchId: batch.id, printedAt: { not: null } },
    });

    res.json({
      success: true,
      data: {
        batchId: batch.id,
        status: batch.status,
        total: batch.orderCount,
        processed: processedCount,
        pdfUrl: batch.pdfUrl || null,
      },
    });
  } catch (err) {
    console.error('Batch status error:', err);
    res.status(500).json({ success: false, error: 'Failed to get batch status' });
  }
});

/**
 * GET /batch/:id/download - Download completed PDF
 */
router.get('/batch/:id/download', async (req, res) => {
  try {
    const batch = await prisma.printBatch.findUnique({
      where: { id: req.params.id },
    });

    if (!batch) {
      return res.status(404).json({ success: false, error: 'Batch not found' });
    }

    if (batch.status !== 'COMPLETED' || !batch.pdfUrl) {
      return res.status(400).json({ success: false, error: 'PDF not yet available' });
    }

    const fs = require('fs');
    const path = require('path');
    const pdfPath = path.resolve(batch.pdfUrl);

    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ success: false, error: 'PDF file not found' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="batch-${batch.id}.pdf"`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    console.error('Batch download error:', err);
    res.status(500).json({ success: false, error: 'Failed to download PDF' });
  }
});

/**
 * GET /history - Print history
 */
router.get('/history', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const where = {};
    if (req.user.role === 'STAFF') {
      where.userId = req.user.id;
    }

    const [batches, total] = await Promise.all([
      prisma.printBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, name: true } },
        },
      }),
      prisma.printBatch.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        batches,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }
});

// ── Shopee-issued air waybills ────────────────────────────────────────────────

/** MIME type to serve a downloaded AWB with, per detected format (KB §7.2). */
const AWB_CONTENT_TYPES = {
  pdf:  'application/pdf',
  html: 'text/html; charset=utf-8',
  zip:  'application/zip',
};

/**
 * POST /awb - Download the official Shopee air waybill for the given orders.
 *
 * This is the Shopee-generated label (KB §5 step 7b), as opposed to the
 * self-rendered receipt produced by /batch. Shopee decides the file format, so
 * the response is not always a PDF.
 *
 * Body: { ids: string[], shippingDocumentType? }
 */
router.post('/awb', async (req, res) => {
  try {
    const { ids, shippingDocumentType } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    }
    if (ids.length > MAX_AWB_BATCH_SIZE) {
      return res.status(400).json({
        success: false,
        error: `Shopee accepts at most ${MAX_AWB_BATCH_SIZE} packages per air waybill request`,
      });
    }

    if (req.user.role === 'STAFF') {
      const rows = await prisma.order.findMany({
        where: { id: { in: ids } },
        select: { storeId: true },
      });
      const access = await prisma.storeAccess.findMany({
        where: { userId: req.user.id },
        select: { storeId: true },
      });
      const allowed = new Set(access.map((a) => a.storeId));
      if (rows.some((r) => !allowed.has(r.storeId))) {
        return res.status(403).json({ success: false, error: 'No access to some of the selected orders' });
      }
    }

    const doc = await fulfillmentService.fetchAwb(ids, { shippingDocumentType });

    await prisma.order.updateMany({
      where: { id: { in: ids } },
      data: { printedAt: new Date(), printedById: req.user.id },
    });

    const extension = doc.format === 'unknown' ? 'bin' : doc.format;
    res.setHeader('Content-Type', AWB_CONTENT_TYPES[doc.format] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="awb-${Date.now()}.${extension}"`);
    return res.send(doc.buffer);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('AWB download error:', err);
    else console.warn(`AWB download rejected: ${err.message}`);
    return res.status(status).json({ success: false, error: err.message || 'Failed to download air waybill' });
  }
});

/**
 * GET /awb/:orderId - Re-serve a previously downloaded Shopee AWB.
 *
 * Reprinting from the stored file avoids a second round trip to Shopee and
 * still works once the package has left the printing window.
 */
router.get('/awb/:orderId', async (req, res) => {
  try {
    if (req.user.role === 'STAFF') {
      const order = await prisma.order.findUnique({
        where: { id: req.params.orderId },
        select: { storeId: true },
      });
      if (!order) {
        return res.status(404).json({ success: false, error: 'Order not found' });
      }
      const access = await prisma.storeAccess.findFirst({
        where: { userId: req.user.id, storeId: order.storeId },
      });
      if (!access) {
        return res.status(403).json({ success: false, error: 'No access to this store' });
      }
    }

    const doc = await fulfillmentService.readStoredAwb(req.params.orderId);
    const extension = doc.format === 'unknown' ? 'bin' : doc.format;

    res.setHeader('Content-Type', AWB_CONTENT_TYPES[doc.format] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="awb-${req.params.orderId}.${extension}"`);
    return res.send(doc.buffer);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('Stored AWB error:', err);
    return res.status(status).json({ success: false, error: err.message || 'Failed to read stored air waybill' });
  }
});

/**
 * POST /awb-data - Raw AWB field data for self-designed labels (KB §5 step 7a).
 *
 * Returns the carrier's sort codes and barcode payload, which cannot be
 * reconstructed from order data alone.
 *
 * Body: { ids: string[] }
 */
router.post('/awb-data', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    }

    const data = await fulfillmentService.fetchAwbDataInfo(ids);
    return res.json({ success: true, data });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('AWB data error:', err);
    return res.status(status).json({ success: false, error: err.message || 'Failed to fetch air waybill data' });
  }
});

/**
 * POST /reprint - Reprint an already-printed order
 */
router.post('/reprint', async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, error: 'orderId is required' });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { store: true },
    });

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (!order.printedAt) {
      return res.status(400).json({ success: false, error: 'Order has not been printed yet' });
    }

    // A reprint is still a print: the KB §7.3 window applies just the same.
    const printable = fulfillmentService.checkAwbPrintable(order);
    if (!printable.ok) {
      return res.status(400).json({
        success: false,
        error: `Cannot reprint ${order.orderId}: ${printable.reason}`,
      });
    }

    const awbDataMap = await fulfillmentService.fetchAwbDataForRows([order]);
    const pdfBytes = await pdfService.generateReceipt(
      order,
      awbDataMap.get(`${order.orderId}::${order.packageNumber || ''}`),
    );

    await prisma.order.update({
      where: { id: orderId },
      data: {
        reprintCount: { increment: 1 },
        printedAt: new Date(),
        printedById: req.user.id,
      },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="reprint-${orderId}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('Reprint error:', err);
    res.status(500).json({ success: false, error: 'Failed to reprint' });
  }
});

module.exports = router;
