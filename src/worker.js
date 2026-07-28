const { Worker } = require('bullmq');
const prisma = require('./prisma/client.js');
const { encrypt, decrypt } = require('./utils/crypto.js');
const shopeeService = require('./services/shopee.js');
const tiktokService = require('./services/tiktok.js');
const pdfService = require('./services/pdf.js');
const { connection } = require('./services/queue.js');
const path = require('path');
const fs = require('fs');

// ─── Token refresh helper ─────────────────────────────────────────────────────

/**
 * Ensure the store's access token is valid before making API calls.
 *
 * Strategy:
 *   - If tokenExpiry is more than TOKEN_BUFFER_MINUTES away → token is still good, use it.
 *   - Otherwise → call the platform's refresh endpoint, persist the new token pair
 *     and updated expiry, then return the fresh access token.
 *
 * @param {Object} store - Prisma store record (must have accessToken, refreshToken,
 *                          tokenExpiry, platform, shopId)
 * @returns {Promise<string>} Decrypted, valid access token
 */
const TOKEN_BUFFER_MINUTES = 5; // refresh if less than 5 min left

async function ensureFreshToken(store) {
  const now = new Date();
  const expiry = store.tokenExpiry ? new Date(store.tokenExpiry) : new Date(0);
  const minutesLeft = (expiry - now) / 60_000;

  if (minutesLeft > TOKEN_BUFFER_MINUTES) {
    // Token still valid — just decrypt and return
    console.log(`[token] Store ${store.id} token valid for ~${Math.floor(minutesLeft)} more minutes`);
    return decrypt(store.accessToken);
  }

  // Token expired or about to expire — refresh it
  console.log(`[token] Store ${store.id} token expiring soon (${minutesLeft.toFixed(1)} min left). Refreshing…`);

  if (!store.refreshToken) {
    throw new Error(`Store ${store.id}: token expired and no refresh token available. Please reconnect the store.`);
  }

  const refreshToken = decrypt(store.refreshToken);
  let newAccessToken;
  let newRefreshToken;

  if (store.platform === 'SHOPEE') {
    const result = await shopeeService.refreshToken(refreshToken, store.shopId);
    newAccessToken = result.access_token;
    newRefreshToken = result.refresh_token;
  } else if (store.platform === 'TIKTOK') {
    const result = await tiktokService.refreshToken(refreshToken);
    newAccessToken = result.access_token;
    newRefreshToken = result.refresh_token;
  } else {
    throw new Error(`Store ${store.id}: unsupported platform ${store.platform} for token refresh`);
  }

  if (!newAccessToken) {
    throw new Error(`Store ${store.id}: refresh token call returned no access_token`);
  }

  // Persist new tokens + expiry (Shopee ~4h, TikTok ~24h)
  const expiryHours = store.platform === 'TIKTOK' ? 24 : 4;
  const updateData = {
    accessToken: encrypt(newAccessToken),
    tokenExpiry: new Date(Date.now() + expiryHours * 60 * 60 * 1000),
  };
  if (newRefreshToken) {
    updateData.refreshToken = encrypt(newRefreshToken);
  }

  await prisma.store.update({
    where: { id: store.id },
    data: updateData,
  });

  console.log(`[token] Store ${store.id} token refreshed successfully (new expiry: +${expiryHours}h)`);
  return newAccessToken;
}

// ─── Sync job handler ─────────────────────────────────────────────────────────

/**
 * Sync job handler
 * Fetches READY_TO_SHIP orders from the store's platform API and upserts them.
 */
async function handleSync(job) {
  const { storeId } = job.data;
  console.log(`[sync] Starting sync for store ${storeId}`);

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new Error(`Store ${storeId} not found`);
  }

  // Auto-refresh token if expired or expiring soon
  const accessToken = await ensureFreshToken(store);
  const shopId = store.shopId;


  let orders = [];
  if (store.platform === 'SHOPEE') {
    // Get order list from Shopee API
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60;

    const orderListResp = await shopeeService.getOrderList(accessToken, shopId, {
      orderStatus: 'READY_TO_SHIP',
      timeFrom: thirtyDaysAgo,
      timeTo: now,
      pageSize: 100,
    });

    const orderSns = (orderListResp.response?.order_list || []).map(o => o.order_sn);

    if (orderSns.length > 0) {
      // Get full details
      const detailResp = await shopeeService.getOrderDetail(accessToken, shopId, orderSns);
      orders = (detailResp.response?.order_list || []).map(o => ({
        orderId: o.order_sn,
        buyerName: o.buyer_username || o.recipient_address?.name || 'Unknown',
        buyerAddress: o.recipient_address?.full_address || '',
        buyerPhone: o.recipient_address?.phone || '',
        buyerCity: o.recipient_address?.city || '',
        buyerProvince: o.recipient_address?.state || '',
        buyerPostalCode: o.recipient_address?.zipcode || '',
        items: (o.item_list || []).map(item => ({
          name: item.item_name,
          quantity: item.model_quantity_purchased || 1,
          price: item.model_discounted_price || item.item_price || 0,
        })),
        shippingCourier: o.shipping_carrier || '',
        shippingService: o.tracking_number ? 'REG' : '',
        trackingNumber: o.tracking_number || null,
        status: 'READY_TO_SHIP',
        orderDate: new Date((o.create_time || now) * 1000),
      }));
    }
  } else if (store.platform === 'TIKTOK') {
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60;

    const searchResp = await tiktokService.searchOrders(accessToken, {
      orderStatus: 'AWAITING_SHIP',
      createTimeFrom: thirtyDaysAgo,
      createTimeTo: now,
      pageSize: 100,
    });

    const orderIds = (searchResp.orders || []).map(o => o.order_id);

    if (orderIds.length > 0) {
      const detailResp = await tiktokService.getOrderDetail(accessToken, orderIds);
      orders = (detailResp.orders || []).map(o => ({
        orderId: o.order_id,
        buyerName: o.buyer_info?.name || 'Unknown',
        buyerAddress: o.recipient_address?.address_detail || '',
        buyerPhone: o.recipient_address?.phone || '',
        buyerCity: o.recipient_address?.city || '',
        buyerProvince: o.recipient_address?.state || '',
        buyerPostalCode: o.recipient_address?.zip_code || '',
        items: (o.line_items || []).map(item => ({
          name: item.product_name,
          quantity: item.quantity || 1,
          price: item.sale_price || 0,
        })),
        shippingCourier: o.shipping_provider || '',
        shippingService: '',
        trackingNumber: o.tracking_number || null,
        status: 'READY_TO_SHIP',
        orderDate: new Date((o.create_time || now) * 1000),
      }));
    }
  } else {
    throw new Error(`Unsupported platform: ${store.platform}`);
  }

  console.log(`[sync] Fetched ${orders.length} orders from ${store.platform} for store ${storeId}`);

  let created = 0;
  let updated = 0;

  for (const orderData of orders) {
    const existing = await prisma.order.findFirst({
      where: { orderId: orderData.orderId, storeId },
    });

    if (existing) {
      await prisma.order.update({
        where: { id: existing.id },
        data: {
          status: orderData.status,
          trackingNumber: orderData.trackingNumber || existing.trackingNumber,
          shippingCourier: orderData.shippingCourier || existing.shippingCourier,
          items: orderData.items,
        },
      });
      updated++;
    } else {
      await prisma.order.create({
        data: {
          orderId: orderData.orderId,
          storeId,
          buyerName: orderData.buyerName,
          buyerAddress: orderData.buyerAddress,
          buyerPhone: orderData.buyerPhone,
          buyerCity: orderData.buyerCity,
          buyerProvince: orderData.buyerProvince,
          buyerPostalCode: orderData.buyerPostalCode,
          items: orderData.items,
          shippingCourier: orderData.shippingCourier,
          shippingService: orderData.shippingService,
          trackingNumber: orderData.trackingNumber,
          status: orderData.status,
          orderDate: orderData.orderDate,
        },
      });
      created++;
    }
  }

  console.log(`[sync] Completed sync for store ${storeId}: ${created} created, ${updated} updated`);
  return { storeId, total: orders.length, created, updated };
}

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

  // Generate batch PDF
  const pdfBuffer = await pdfService.generateBatchPdf(orders);

  // Save PDF to disk
  const pdfDir = path.resolve('./storage/pdfs');
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

module.exports = { syncWorker, printWorker };
