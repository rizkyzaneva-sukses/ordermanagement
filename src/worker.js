const { Worker } = require('bullmq');
const { handleSync }      = require('./services/syncDirect.js');
const pdfService          = require('./services/pdf.js');
const fulfillmentService  = require('./services/fulfillment.js');
const prisma              = require('./prisma/client.js');
const { connection }      = require('./services/queue.js');
const config              = require('./config/index.js');
const path = require('path');
const fs   = require('fs');



// ─── Workers ────────────────────────────────────────────────────────────────

/**
 * Print batch job handler
 */
async function handlePrintBatch(job) {
  const { batchId, orderIds } = job.data;
  console.log(`[print-batch] Starting batch ${batchId}`);

  const batch = await prisma.printBatch.findUnique({ where: { id: batchId } });
  if (!batch) {
    throw new Error(`Print batch ${batchId} not found`);
  }

  // Update batch status to PROCESSING
  await prisma.printBatch.update({
    where: { id: batchId },
    data: { status: 'PROCESSING' },
  });

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    include: { store: true },
  });

  if (orders.length === 0) {
    throw new Error(`No orders found in batch ${batchId}`);
  }

  // Re-check the KB §7.3 printing window. The route already validated this at
  // enqueue time, but a queued batch can sit long enough for the 3PL to collect
  // the parcel in the meantime, and a label printed after that is worthless.
  const notPrintable = orders
    .map((o) => ({ order: o, check: fulfillmentService.checkAwbPrintable(o) }))
    .filter((x) => !x.check.ok);

  if (notPrintable.length > 0) {
    const detail = notPrintable.map((x) => `${x.order.orderId} (${x.check.reason})`).join(', ');
    await prisma.printBatch.update({
      where: { id: batchId },
      data: { status: 'FAILED' },
    });
    // Non-retryable: waiting will not move these packages back into the window
    throw new Error(`Batch ${batchId} no longer printable: ${detail}`);
  }

  // Parse items (stored as JSON string in DB) before generating PDF
  const ordersWithItems = orders.map((o) => {
    let items = o.items;
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch { items = []; }
    }
    return { ...o, items: Array.isArray(items) ? items : [] };
  });

  // Generate batch PDF, enriched with Shopee's AWB routing data (KB §5 step 7a)
  const awbDataMap = await fulfillmentService.fetchAwbDataForRows(orders);
  const pdfBuffer = await pdfService.generateBatchPdf(ordersWithItems, awbDataMap);

  // Save PDF to disk
  const pdfDir = path.join(config.storage.dir, 'pdfs');
  if (!fs.existsSync(pdfDir)) {
    fs.mkdirSync(pdfDir, { recursive: true });
  }
  const pdfPath = path.join(pdfDir, `batch-${batchId}.pdf`);
  fs.writeFileSync(pdfPath, pdfBuffer);

  // Update batch status
  await prisma.printBatch.update({
    where: { id: batchId },
    data: {
      status: 'COMPLETED',
      pdfUrl: pdfPath,
      completedAt: new Date(),
    },
  });

  // Update all orders: mark as printed
  await prisma.order.updateMany({
    where: { id: { in: orderIds } },
    data: {
      printedAt: new Date(),
      printedById: batch.userId,
      batchId: batchId,
    },
  });

  console.log(`[print-batch] Completed batch ${batchId}: ${orders.length} orders`);
  return { batchId, orderCount: orders.length, pdfPath };
}

// Create workers
const syncWorker = new Worker('order-sync', handleSync, {
  connection,
  concurrency: 3,
});

const printWorker = new Worker('print-batch', handlePrintBatch, {
  connection,
  concurrency: 2,
});

syncWorker.on('completed', (job) => {
  console.log(`[sync] Job ${job.id} completed`);
});

syncWorker.on('failed', (job, err) => {
  console.error(`[sync] Job ${job?.id} failed:`, err.message);
});

printWorker.on('completed', (job) => {
  console.log(`[print-batch] Job ${job.id} completed`);
});

printWorker.on('failed', (job, err) => {
  console.error(`[print-batch] Job ${job?.id} failed:`, err.message);
});

console.log('[worker] OrderPro workers started');

module.exports = { syncWorker, printWorker, handleSync, handlePrintBatch };
