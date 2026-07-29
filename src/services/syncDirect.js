'use strict';

/**
 * syncDirect.js — Sync a store's orders without going through BullMQ/Redis.
 *
 * This module is used as a fallback when Redis is unavailable.
 * It is also imported by worker.js so the actual job handler logic lives here.
 *
 * Usage:
 *   const { syncStore } = require('./syncDirect');
 *   await syncStore(storeId);
 */

const prisma         = require('../prisma/client.js');
const { encrypt, decrypt } = require('../utils/crypto.js');
const shopeeService  = require('./shopee.js');
const tiktokService  = require('./tiktok.js');

// ── Token refresh helper ───────────────────────────────────────────────────────

const TOKEN_BUFFER_MINUTES = 5; // refresh if less than 5 min left

async function ensureFreshToken(store) {
  const now      = new Date();
  const expiry   = store.tokenExpiry ? new Date(store.tokenExpiry) : new Date(0);
  const minutesLeft = (expiry - now) / 60_000;

  if (minutesLeft > TOKEN_BUFFER_MINUTES) {
    console.log(`[token] Store ${store.id} token valid for ~${Math.floor(minutesLeft)} more minutes`);
    return decrypt(store.accessToken);
  }

  console.log(`[token] Store ${store.id} token expiring soon (${minutesLeft.toFixed(1)} min left). Refreshing…`);

  if (!store.refreshToken) {
    throw new Error(`Store ${store.id}: token expired and no refresh token available. Please reconnect the store.`);
  }

  const refreshToken = decrypt(store.refreshToken);
  let newAccessToken;
  let newRefreshToken;

  if (store.platform === 'SHOPEE') {
    const result  = await shopeeService.refreshToken(refreshToken, store.shopId);
    newAccessToken  = result.access_token;
    newRefreshToken = result.refresh_token;
  } else if (store.platform === 'TIKTOK') {
    const result  = await tiktokService.refreshToken(refreshToken);
    newAccessToken  = result.access_token;
    newRefreshToken = result.refresh_token;
  } else {
    throw new Error(`Store ${store.id}: unsupported platform ${store.platform} for token refresh`);
  }

  if (!newAccessToken) {
    throw new Error(`Store ${store.id}: refresh token call returned no access_token`);
  }

  const expiryHours = store.platform === 'TIKTOK' ? 24 : 4;
  const updateData  = {
    accessToken:  encrypt(newAccessToken),
    tokenExpiry:  new Date(Date.now() + expiryHours * 60 * 60 * 1000),
  };
  if (newRefreshToken) {
    updateData.refreshToken = encrypt(newRefreshToken);
  }

  await prisma.store.update({ where: { id: store.id }, data: updateData });
  console.log(`[token] Store ${store.id} token refreshed successfully (new expiry: +${expiryHours}h)`);
  return newAccessToken;
}

// ── Core sync function ────────────────────────────────────────────────────────

/**
 * Fetch orders from the platform API and upsert them into the DB.
 *
 * @param {string} storeId
 * @returns {Promise<{ storeId, total, created, updated }>}
 */
async function syncStore(storeId) {
  console.log(`[sync] Starting sync for store ${storeId}`);

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new Error(`Store ${storeId} not found`);
  }

  const accessToken = await ensureFreshToken(store);
  const shopId      = store.shopId;

  let orders = [];

  if (store.platform === 'SHOPEE') {
    const now           = Math.floor(Date.now() / 1000);
    // Shopee API max time range is 15 days
    const fifteenDaysAgo = now - 15 * 24 * 60 * 60;

    const orderListResp = await shopeeService.getOrderList(accessToken, shopId, {
      orderStatus: 'READY_TO_SHIP',
      timeFrom:    fifteenDaysAgo,
      timeTo:      now,
      pageSize:    100,
    });

    console.log(`[sync] getOrderList raw response keys: ${Object.keys(orderListResp || {}).join(', ')}`);
    console.log(`[sync] getOrderList response.order_list count: ${orderListResp?.response?.order_list?.length ?? 'undefined'}`);

    const orderSns = (orderListResp.response?.order_list || []).map(o => o.order_sn);
    console.log(`[sync] Found ${orderSns.length} READY_TO_SHIP orders in last 15 days`);

    if (orderSns.length > 0) {
      // Get full details — must request optional fields or Shopee returns minimal data
      const detailResp = await shopeeService.getOrderDetail(accessToken, shopId, orderSns, {
        response_optional_fields: 'item_list,recipient_address,shipping_carrier'
      });

      console.log(`[sync] getOrderDetail response order count: ${detailResp?.response?.order_list?.length ?? 'undefined'}`);

      orders = (detailResp.response?.order_list || []).map(o => ({
        orderId:         o.order_sn,
        buyerName:       o.buyer_username || o.recipient_address?.name || 'Unknown',
        buyerAddress:    o.recipient_address?.full_address || '',
        buyerPhone:      o.recipient_address?.phone || '',
        buyerCity:       o.recipient_address?.city || '',
        buyerProvince:   o.recipient_address?.state || '',
        buyerPostalCode: o.recipient_address?.zipcode || '',
        items: (o.item_list || []).map(item => ({
          name:     item.item_name,
          quantity: item.model_quantity_purchased || 1,
          price:    item.model_discounted_price || item.item_price || 0,
        })),
        shippingCourier: o.shipping_carrier || '',
        shippingService: o.tracking_number ? 'REG' : '',
        trackingNumber:  o.tracking_number || null,
        status:          'READY_TO_SHIP',
        orderDate:       new Date((o.create_time || now) * 1000),
      }));
    }
  } else if (store.platform === 'TIKTOK') {
    const now           = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60;

    const searchResp = await tiktokService.searchOrders(accessToken, {
      orderStatus:    'AWAITING_SHIP',
      createTimeFrom: thirtyDaysAgo,
      createTimeTo:   now,
      pageSize:       100,
    });

    const orderIds = (searchResp.orders || []).map(o => o.order_id);

    if (orderIds.length > 0) {
      const detailResp = await tiktokService.getOrderDetail(accessToken, orderIds);
      orders = (detailResp.orders || []).map(o => ({
        orderId:         o.order_id,
        buyerName:       o.buyer_info?.name || 'Unknown',
        buyerAddress:    o.recipient_address?.address_detail || '',
        buyerPhone:      o.recipient_address?.phone || '',
        buyerCity:       o.recipient_address?.city || '',
        buyerProvince:   o.recipient_address?.state || '',
        buyerPostalCode: o.recipient_address?.zip_code || '',
        items: (o.line_items || []).map(item => ({
          name:     item.product_name,
          quantity: item.quantity || 1,
          price:    item.sale_price || 0,
        })),
        shippingCourier: o.shipping_provider || '',
        shippingService: '',
        trackingNumber:  o.tracking_number || null,
        status:          'READY_TO_SHIP',
        orderDate:       new Date((o.create_time || now) * 1000),
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
          status:          orderData.status,
          trackingNumber:  orderData.trackingNumber || existing.trackingNumber,
          shippingCourier: orderData.shippingCourier || existing.shippingCourier,
          items:           JSON.stringify(Array.isArray(orderData.items) ? orderData.items : []),
        },
      });
      updated++;
    } else {
      await prisma.order.create({
        data: {
          orderId:         orderData.orderId,
          storeId,
          buyerName:       orderData.buyerName,
          buyerAddress:    orderData.buyerAddress,
          buyerPhone:      orderData.buyerPhone,
          buyerCity:       orderData.buyerCity,
          buyerProvince:   orderData.buyerProvince,
          buyerPostalCode: orderData.buyerPostalCode,
          items:           JSON.stringify(Array.isArray(orderData.items) ? orderData.items : []),
          shippingCourier: orderData.shippingCourier,
          shippingService: orderData.shippingService,
          trackingNumber:  orderData.trackingNumber,
          status:          orderData.status,
          orderDate:       orderData.orderDate,
        },
      });
      created++;
    }
  }

  await prisma.store.update({
    where: { id: storeId },
    data:  { lastSyncAt: new Date() },
  });

  console.log(`[sync] Completed sync for store ${storeId}: ${created} created, ${updated} updated`);
  return { storeId, total: orders.length, created, updated };
}

/**
 * BullMQ-compatible job handler wrapper.
 * Call: handleSync(job) where job.data = { storeId }
 */
async function handleSync(job) {
  return syncStore(job.data.storeId);
}

module.exports = { syncStore, handleSync, ensureFreshToken };
