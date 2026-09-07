const { Worker } = require('bullmq');
const { handleSync }      = require('./services/syncDirect.js');
const pdfService          = require('./services/pdf.js');
const fulfillmentService  = require('./services/fulfillment.js');
const prisma              = require('./prisma/client.js');
const { connection, syncQueue, isRedisReady, hasQueueWorkers } = require('./services/queue.js');
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

// ─── Liveness heartbeat ─────────────────────────────────────────────────────
//
// A worker can stop consuming without the process ever dying: the Redis link
// drops, the blocking read never resumes, and from the outside the container is
// still "Up" with a healthy exit code nobody ever sees. That is exactly how
// automatic sync stopped between 5 and 7 September 2026 — the API kept queueing
// push-triggered jobs the whole time, and nothing took them.
//
// `restart: unless-stopped` cannot help there, because the process never exits.
// So the cure for a deaf worker is to stop being one: exit, and let the platform
// hand the queue to a fresh copy. That the platform does so was verified by hand
// on EasyPanel (Docker Swarm restarts a service task on any exit), and the queue
// is durable, so the backlog is picked up on the way back in.

/** How often to ask whether this process is still consuming. */
const HEARTBEAT_EVERY_MS = 60_000;

/**
 * Consecutive failed checks before giving up.
 *
 * Five minutes of silence, so an ordinary Redis blip — which `retryStrategy`
 * recovers from on its own within seconds — never costs a restart.
 */
const STRIKES_BEFORE_EXIT = 5;

/**
 * Grace period before the first check.
 *
 * On a redeploy this container routinely comes up before Redis is resolvable.
 * Checking immediately would read that as failure and exit into a restart loop
 * that outlives Redis' own startup.
 */
const HEARTBEAT_GRACE_MS = 120_000;

let unhealthyStrikes = 0;

/**
 * One liveness pass: is this process actually able to take work?
 *
 * Registration on the queue is checked, not merely a reachable Redis — BullMQ
 * publishes each running worker under the queue, so a process that cannot see
 * itself there is not consuming no matter what its own state says.
 */
async function heartbeat() {
  const reasons = [];

  if (!isRedisReady()) {
    reasons.push(`redis status=${connection.status}`);
  } else if (!syncWorker.isRunning()) {
    reasons.push('sync worker is not running');
  } else if (!(await hasQueueWorkers(syncQueue))) {
    reasons.push('worker is not registered on the order-sync queue');
  }

  if (reasons.length === 0) {
    if (unhealthyStrikes > 0) {
      console.log(`[worker] Consuming again after ${unhealthyStrikes} failed check(s)`);
      unhealthyStrikes = 0;
    }
    return;
  }

  unhealthyStrikes += 1;
  console.error(
    `[worker] Liveness check failed (${unhealthyStrikes}/${STRIKES_BEFORE_EXIT}): ${reasons.join('; ')}`
  );

  if (unhealthyStrikes >= STRIKES_BEFORE_EXIT) {
    console.error(
      '[worker] Still not consuming after ' +
      `${(STRIKES_BEFORE_EXIT * HEARTBEAT_EVERY_MS) / 60_000} minutes — exiting so a fresh container takes over`
    );
    process.exit(1);
  }
}

setTimeout(() => {
  // unref'd so the heartbeat is never the reason this process stays alive: if
  // the queue consumers have gone, exiting is the outcome we want anyway.
  setInterval(() => {
    heartbeat().catch((err) => console.error('[worker] Heartbeat itself failed:', err.message));
  }, HEARTBEAT_EVERY_MS).unref();
  console.log(`[worker] Liveness heartbeat active (every ${HEARTBEAT_EVERY_MS / 1000}s)`);
}, HEARTBEAT_GRACE_MS).unref();

console.log('[worker] OrderPro workers started');

module.exports = { syncWorker, printWorker, handleSync, handlePrintBatch };
