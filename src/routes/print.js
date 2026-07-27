const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client.js');
const pdfService = require('../services/pdf.js');
const { printQueue } = require('../services/queue.js');
const { authenticate } = require('../middleware/auth.js');

const MAX_BATCH_SIZE = 300;

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

    const pdfBytes = await pdfService.generateReceipt(order);

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

    // Validate: all unprinted and have tracking numbers
    const invalid = orders.filter((o) => o.printedAt || !o.trackingNumber);
    if (invalid.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'All orders must be unprinted and have tracking numbers',
        invalidOrderIds: invalid.map((o) => o.id),
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

    // Create PrintBatch record
    const batch = await prisma.printBatch.create({
      data: {
        userId: req.user.id,
        platform: platform,
        storeIds: storeIds,
        orderCount: orders.length,
        status: 'PENDING',
      },
    });

    // Update orders with batchId and isBatchSelected
    await prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: { isBatchSelected: true, batchId: batch.id },
    });

    // Enqueue for async processing
    await printQueue.add('process-batch', {
      batchId: batch.id,
      orderIds,
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 86400 },
    });

    res.status(201).json({
      success: true,
      data: { batchId: batch.id, status: batch.status, orderCount: orders.length },
    });
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

    const pdfBytes = await pdfService.generateReceipt(order);

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
