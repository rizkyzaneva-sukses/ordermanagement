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
const shopeeService  = require('./shopee.js');
const tiktokService  = require('./tiktok.js');
const { ensureFreshToken, isReconnectError } = require('./tokens.js');
const { orderNeedsDetail } = require('./orderRefresh.js');

// ── Shopee helpers ────────────────────────────────────────────────────────────

/**
 * Build an index of order_sn → package numbers for everything not yet shipped.
 *
 * `search_package_list` is the KB-preferred entry point (Rule #4) and the only
 * one that hands back `package_number`, which is what lets a split order be
 * fulfilled and printed per package rather than as one lump.
 *
 * Failure here is not fatal: the caller still discovers orders through
 * `get_order_list`, it just cannot address individual packages.
 *
 * @returns {Promise<Map<string, Set<string>>>}
 */
async function fetchShopeePackageIndex(accessToken, shopId, warnings) {
  const index = new Map();

  try {
    // package_status 0 = All → NOT_START, READY, PICKUP_RETRY, REQUEST_CREATED (KB §3.1)
    const packages = await shopeeService.getAllPackages(accessToken, shopId, 0);

    for (const pkg of packages) {
      if (!pkg.order_sn) continue;
      if (!index.has(pkg.order_sn)) index.set(pkg.order_sn, new Set());
      if (pkg.package_number) index.get(pkg.order_sn).add(String(pkg.package_number));
    }

    console.log(`[sync] search_package_list: ${packages.length} package(s) across ${index.size} order(s)`);
  } catch (err) {
    console.warn(`[sync] search_package_list failed, continuing without package numbers: ${err.message}`);
    if (warnings) warnings.push(`search_package_list: ${err.message}`);
  }

  return index;
}

/**
 * Expand one `get_order_detail` result into one row per package.
 *
 * KB §1: the package, not the order, is the shipping unit. When Shopee returns
 * no package breakdown the order is treated as a single default package whose
 * `packageNumber` is the empty string.
 *
 * @param {Object} order - An entry from get_order_detail's order_list
 * @param {Set<string>} [knownPackages] - Package numbers seen via search_package_list
 * @returns {Object[]}
 */
function expandShopeeOrderToPackages(order, knownPackages) {
  const baseItems = (order.item_list || []).map(item => ({
    name:     item.item_name,
    quantity: item.model_quantity_purchased || 1,
    price:    item.model_discounted_price || item.item_price || 0,
    itemId:   item.item_id,
    modelId:  item.model_id,
    // Needed to build a split_order payload and to detect items that may not be
    // separated: same orderItemId = bundle deal, same addOnDealId = add-on (KB §6.3)
    orderItemId:      item.order_item_id,
    promotionGroupId: item.promotion_group_id,
    addOnDealId:      item.add_on_deal_id,
  }));

  const common = {
    orderId:         order.order_sn,
    buyerName:       order.recipient_address?.name || order.buyer_username || 'Unknown',
    buyerAddress:    order.recipient_address?.full_address || '',
    buyerPhone:      order.recipient_address?.phone || '',
    buyerCity:       order.recipient_address?.city || '',
    buyerProvince:   order.recipient_address?.state || '',
    buyerPostalCode: order.recipient_address?.zipcode || '',
    buyerNote:       order.note || null,
    paymentMethod:   order.payment_method || null,
    status:          order.order_status || null,
    orderDate:       new Date((order.create_time || Math.floor(Date.now() / 1000)) * 1000),
  };

  const packageList = Array.isArray(order.package_list) ? order.package_list : [];

  if (packageList.length === 0) {
    // No breakdown from the API — fall back to a package number we may already
    // know from search_package_list, otherwise the default single package.
    const fallbackPackage = knownPackages && knownPackages.size === 1
      ? [...knownPackages][0]
      : '';

    return [{
      ...common,
      packageNumber:   fallbackPackage,
      logisticsStatus: null,
      logisticsChannelId: null,
      shippingCourier: order.shipping_carrier || '',
      shippingService: order.tracking_number ? 'REG' : '',
      trackingNumber:  order.tracking_number || null,
      items:           baseItems,
    }];
  }

  return packageList.map((pkg, idx) => {
    // Each package carries its own item subset; match it back to the richer
    // order-level item data so names and prices survive.
    const pkgItems = Array.isArray(pkg.item_list) && pkg.item_list.length > 0
      ? pkg.item_list.map(pi => {
        const match = baseItems.find(bi =>
          bi.itemId === pi.item_id && (bi.modelId === pi.model_id || !pi.model_id));
        return match || {
          name:     pi.item_name || 'Product',
          quantity: pi.model_quantity_purchased || pi.quantity || 1,
          price:    0,
          itemId:   pi.item_id,
          modelId:  pi.model_id,
        };
      })
      : baseItems;

    return {
      ...common,
      packageNumber:   String(pkg.package_number || ''),
      logisticsStatus: pkg.logistics_status || null,
      logisticsChannelId: pkg.logistics_channel_id ?? null,
      shippingCourier: pkg.shipping_carrier || order.shipping_carrier || '',
      // Only a single-package order can safely inherit the order-level tracking
      // number; for split orders it belongs to one specific package.
      trackingNumber:  packageList.length === 1 ? (order.tracking_number || null) : null,
      shippingService: (packageList.length === 1 && order.tracking_number) ? 'REG' : '',
      items:           pkgItems,
      _packageIndex:   idx,
    };
  });
}

/**
 * Fill in tracking numbers that `get_order_detail` could not supply.
 *
 * Split orders report tracking per package, and a package can sit in
 * `PROCESSED` for a while before the 3PL issues one at all (KB §9), so this is
 * best-effort: rows keep a null tracking number and get picked up next sync.
 *
 * Mutates `rows` in place.
 */
async function backfillShopeeTracking(accessToken, shopId, rows) {
  // Note there is no `packageNumber` requirement here: a single-package order
  // carries the empty string, and excluding it skipped exactly the common case.
  const needsTracking = rows.filter(r =>
    !r.trackingNumber &&
    ['PROCESSED', 'RETRY_SHIP', 'SHIPPED'].includes(r.status));

  if (needsTracking.length === 0) return;

  console.log(`[sync] Backfilling tracking numbers for ${needsTracking.length} package(s)`);

  for (let i = 0; i < needsTracking.length; i += 50) {
    const chunk = needsTracking.slice(i, i + 50);

    try {
      const resp = await shopeeService.getMassTrackingNumber(accessToken, shopId,
        chunk.map(r => ({ order_sn: r.orderId, package_number: r.packageNumber || undefined })));

      for (const result of extractTrackingResults(resp)) {
        const row = chunk.find(r =>
          r.orderId === result.order_sn &&
          (r.packageNumber || '') === String(result.package_number || ''));
        if (row) row.trackingNumber = result.tracking_number;
      }
    } catch (err) {
      console.warn(`[sync] Mass tracking lookup failed for ${chunk.length} package(s): ${err.message}`);
    }
  }

  // Anything the batch call did not resolve is retried one at a time. The
  // single-package endpoint has a simpler, better-known response shape, so this
  // also covers the case where the batch response is shaped unexpectedly.
  const stillMissing = needsTracking.filter(r => !r.trackingNumber);

  if (stillMissing.length > 0) {
    console.warn(`[sync] Mass lookup resolved ${needsTracking.length - stillMissing.length}/${needsTracking.length} — retrying ${stillMissing.length} individually`);

    for (const row of stillMissing) {
      try {
        const resp = await shopeeService.getTrackingNumber(
          accessToken, shopId, row.orderId, row.packageNumber || undefined);
        const tracking = resp.response?.tracking_number;
        if (tracking) row.trackingNumber = tracking;
      } catch (err) {
        console.warn(`[sync] Tracking lookup failed for ${row.orderId}: ${err.message}`);
      }
    }
  }

  const resolved = needsTracking.filter(r => r.trackingNumber).length;
  console.log(`[sync] Tracking backfill: ${resolved}/${needsTracking.length} resolved`);

  // A shipped package always has a tracking number upstream, so leaving one
  // unresolved means our request or our reading of the response is wrong —
  // worth saying out loud rather than silently storing null.
  const shippedWithout = needsTracking.filter(r => !r.trackingNumber && r.status === 'SHIPPED');
  if (shippedWithout.length > 0) {
    console.error(`[sync] WARNING: ${shippedWithout.length} SHIPPED package(s) still have no tracking number — e.g. ${shippedWithout[0].orderId}. This usually means the tracking API response was not understood; run scripts/diagnose-shopee.js.`);
  }
}

/**
 * Pull tracking entries out of a `get_mass_tracking_number` response.
 *
 * The field holding the list is not documented in the KB, so rather than betting
 * on one name we take the known candidates and, failing those, any array in the
 * response whose items carry a tracking number.
 *
 * @param {Object} resp
 * @returns {Array<{ order_sn: string, package_number?: string, tracking_number: string }>}
 */
function extractTrackingResults(resp) {
  const response = resp?.response;
  if (!response) return [];

  const candidates = [
    response.success_list,
    response.order_list,
    response.result_list,
    response.tracking_number_list,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.some(x => x?.tracking_number)) {
      return candidate.filter(x => x?.tracking_number);
    }
  }

  // Last resort: any array of objects that look like tracking entries
  for (const value of Object.values(response)) {
    if (Array.isArray(value) && value.some(x => x?.tracking_number && x?.order_sn)) {
      console.warn('[sync] Tracking list found under an unexpected response key — please report this');
      return value.filter(x => x?.tracking_number);
    }
  }

  return [];
}

/**
 * Narrow a run's discovered order_sns down to those worth a get_order_detail.
 *
 * The per-order decision lives in orderRefresh.js so it can be tested without a
 * database; this only supplies it with the local rows to compare against.
 *
 * @param {string} storeId
 * @param {string[]} discovered - order_sns seen in this run
 * @param {Map<string, string|null>} listStatuses - order_sn → status from the list passes
 * @returns {Promise<string[]>}
 */
async function filterOrdersNeedingDetail(storeId, discovered, listStatuses) {
  if (discovered.length === 0) return [];

  const localRows = await prisma.order.findMany({
    where: { storeId },
    select: { orderId: true, status: true, trackingNumber: true },
  });

  const byOrderSn = new Map();
  for (const row of localRows) {
    if (!byOrderSn.has(row.orderId)) byOrderSn.set(row.orderId, []);
    byOrderSn.get(row.orderId).push(row);
  }

  return discovered.filter(orderSn =>
    orderNeedsDetail(listStatuses.get(orderSn), byOrderSn.get(orderSn)));
}

// ── Core sync function ────────────────────────────────────────────────────────

/**
 * Fetch orders from the platform API and upsert them into the DB.
 *
 * Wrapped by `syncStore`, which records the outcome — call that instead.
 *
 * @param {string} storeId
 * @returns {Promise<{ storeId, total, created, updated }>}
 */
async function runStoreSync(storeId) {
  console.log(`[sync] Starting sync for store ${storeId}`);

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    throw new Error(`Store ${storeId} not found`);
  }

  const accessToken = await ensureFreshToken(store);
  const shopId      = store.shopId;

  let orders = [];
  // Shopee only: every order_sn the platform mentioned this run, whether or not
  // we went on to fetch its detail.
  let shopeeSeenSns = null;
  // A status pass that fails takes every order in that status out of the run,
  // which used to be a console.warn and nothing else — the sync still reported
  // success while rows quietly went stale. Collected here and surfaced by
  // syncStore instead.
  const warnings = [];

  if (store.platform === 'SHOPEE') {
    const now            = Math.floor(Date.now() / 1000);
    // Shopee API max time range is 15 days per request
    const fifteenDaysAgo = now - 15 * 24 * 60 * 60;

    // Fetch multiple statuses in parallel — Shopee only supports one status per call
    // Based on KB: READY_TO_SHIP = no tracking yet, PROCESSED = may have tracking,
    // SHIPPED = has tracking (courier scanned AWB)
    //
    // RETRY_SHIP is deliberately absent. It is a real order_status in a
    // get_order_detail response, but get_order_list rejects it as a filter
    // ("order_status is invalid"), so asking for it only ever produced a failed
    // request and an alarming log line every sync. Nothing is lost: a failed
    // pickup leaves the package in LOGISTICS_PICKUP_RETRY, which Pass 0 below
    // picks up via search_package_list(package_status=0), and the authoritative
    // status comes from get_order_detail regardless.
    const STATUSES_TO_FETCH = [
      'READY_TO_SHIP',   // Paid, seller belum kirim
      'PROCESSED',       // Seller sudah ship_order, tracking mungkin belum terbit
      'SHIPPED',         // Kurir sudah scan AWB → pasti ada tracking number
      'UNPAID',          // Belum bayar (opsional, untuk monitoring)
    ];

    // Pass 0: package numbers for everything still awaiting fulfillment.
    // get_order_list is kept alongside it because search_package_list only
    // covers pre-shipment packages — SHIPPED/UNPAID orders never appear there.
    const packageIndex = await fetchShopeePackageIndex(accessToken, shopId, warnings);

    const allOrderSns = new Map(); // order_sn → order_status
    packageIndex.forEach((_pkgs, orderSn) => allOrderSns.set(orderSn, null));

    // Pass 1: fetch by create_time (orders created in last 15 days)
    //
    // getAllOrders follows the pagination cursor. Calling get_order_list directly
    // caps each status at its first 100 rows and discards the rest without any
    // error, which is invisible until you compare totals against Seller Centre.
    await Promise.all(STATUSES_TO_FETCH.map(async (orderStatus) => {
      try {
        const list = await shopeeService.getAllOrders(accessToken, shopId, {
          orderStatus,
          timeRangeField: 'create_time',
          timeFrom: fifteenDaysAgo,
          timeTo:   now,
        });
        console.log(`[sync] create_time | Status ${orderStatus}: ${list.length} order(s)`);
        list.forEach(o => allOrderSns.set(o.order_sn, o.order_status || orderStatus));
      } catch (err) {
        console.warn(`[sync] create_time | Could not fetch status ${orderStatus}: ${err.message}`);
        warnings.push(`create_time/${orderStatus}: ${err.message}`);
      }
    }));

    // Pass 2: fetch by update_time for PROCESSED & SHIPPED — catches orders created
    // >15 days ago that just got tracking numbers or status updates
    const UPDATE_STATUSES = ['PROCESSED', 'SHIPPED'];
    await Promise.all(UPDATE_STATUSES.map(async (orderStatus) => {
      try {
        const list = await shopeeService.getAllOrders(accessToken, shopId, {
          orderStatus,
          timeRangeField: 'update_time',
          timeFrom: fifteenDaysAgo,
          timeTo:   now,
        });
        console.log(`[sync] update_time | Status ${orderStatus}: ${list.length} order(s)`);
        list.forEach(o => {
          // Seeded-but-statusless entries come from search_package_list, so
          // check the value rather than mere presence.
          if (!allOrderSns.get(o.order_sn)) {
            allOrderSns.set(o.order_sn, o.order_status || orderStatus);
          }
        });
      } catch (err) {
        console.warn(`[sync] update_time | Could not fetch status ${orderStatus}: ${err.message}`);
        warnings.push(`update_time/${orderStatus}: ${err.message}`);
      }
    }));

    const discovered = [...allOrderSns.keys()];
    console.log(`[sync] Total unique orders across all passes: ${discovered.length}`);

    // Everything Shopee reported this run, settled ones included — used by the
    // reconciliation pass to tell "not refreshed" from "not mentioned".
    shopeeSeenSns = new Set(discovered);

    // Only orders that can still tell us something get a detail call. On a shop
    // with thousands of orders the old behaviour re-read every one of them
    // every 15 minutes, which is what Shopee's security team flagged as a
    // "substantial surge in Open API calls related to orders".
    const orderSns = await filterOrdersNeedingDetail(storeId, discovered, allOrderSns);
    const skipped = discovered.length - orderSns.length;
    if (skipped > 0) {
      console.log(`[sync] Skipping get_order_detail for ${skipped} settled order(s) already matching Shopee`);
    }

    if (orderSns.length > 0) {
      // Batch into groups of 50 (Shopee limit)
      const chunks = [];
      for (let i = 0; i < orderSns.length; i += 50) {
        chunks.push(orderSns.slice(i, i + 50));
      }

      const allDetails = [];
      for (const chunk of chunks) {
        const detailResp = await shopeeService.getOrderDetail(accessToken, shopId, chunk);
        const list = detailResp.response?.order_list || [];
        console.log(`[sync] getOrderDetail chunk: ${list.length} orders returned`);
        allDetails.push(...list);
      }

      // One row per package, not per order (KB §1)
      orders = allDetails.flatMap(o => {
        const rows = expandShopeeOrderToPackages(o, packageIndex.get(o.order_sn));
        return rows.map(row => ({
          ...row,
          // Use actual status from Shopee, fallback to what we tracked in allOrderSns
          status: row.status || allOrderSns.get(o.order_sn) || 'READY_TO_SHIP',
        }));
      });

      await backfillShopeeTracking(accessToken, shopId, orders);

      const splitCount = orders.length - allDetails.length;
      if (splitCount > 0) {
        console.log(`[sync] ${allDetails.length} order(s) expanded to ${orders.length} package row(s)`);
      }
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

  const { created, updated } = await upsertOrderRows(storeId, orders);

  // Anything Shopee did not hand back this run is still sitting in the database
  // with whatever status it had last time — see reconcileUnseenShopeeOrders.
  let reconciled = 0;
  if (store.platform === 'SHOPEE' && shopeeSeenSns) {
    reconciled = await reconcileUnseenShopeeOrders(store, accessToken, shopeeSeenSns);
  }

  await prisma.store.update({
    where: { id: storeId },
    data:  { lastSyncAt: new Date() },
  });

  console.log(`[sync] Completed sync for store ${storeId}: ${created} created, ${updated} updated, ${reconciled} reconciled`);
  return { storeId, total: orders.length, created, updated, reconciled, warnings };
}

/**
 * Write a batch of fetched rows into the database.
 *
 * Extracted so the reconciliation pass writes through exactly the same rules as
 * the main sync — a second, near-identical loop is how the two drift apart.
 *
 * @param {string} storeId
 * @param {Object[]} orders - Rows from expandShopeeOrderToPackages (or TikTok)
 * @returns {Promise<{created: number, updated: number}>}
 */
async function upsertOrderRows(storeId, orders) {
  let created = 0;
  let updated = 0;
  let adopted = 0;

  // How many package rows this batch carries per order. A single-package order
  // is the only case where a placeholder row can be matched to a package
  // without guessing — see the adoption step below.
  const rowsPerOrder = new Map();
  for (const o of orders) {
    rowsPerOrder.set(o.orderId, (rowsPerOrder.get(o.orderId) || 0) + 1);
  }

  for (const orderData of orders) {
    const packageNumber = orderData.packageNumber || '';

    let existing = await prisma.order.findUnique({
      where: {
        storeId_orderId_packageNumber: { storeId, orderId: orderData.orderId, packageNumber },
      },
    });

    // Rows are keyed by package number, so an order whose reported number
    // changes does not update its row — it creates a second one and strands the
    // first, which then keeps its stale status forever because nothing writes
    // to it again.
    //
    // This is not hypothetical, and it moves in both directions. Pass 0 was
    // failing on every sync, so orders whose get_order_detail carries no
    // package_list were all stored under the empty placeholder; now that the
    // package index works they arrive with a real number. The reconciliation
    // pass has no index at all, so the same order can come back with the
    // placeholder again.
    //
    // When both sides describe exactly one package, they are describing the
    // same package — so re-key the existing row rather than duplicating it.
    // Split orders are left alone: with several packages on each side there is
    // no way to pair them without guessing.
    if (!existing && rowsPerOrder.get(orderData.orderId) === 1) {
      const siblings = await prisma.order.findMany({
        where: { storeId, orderId: orderData.orderId },
      });

      if (siblings.length === 1) {
        // Re-keying makes it the exact-key match, so the update branch below
        // fills in the rest of the fields as it would for any other row.
        existing = await prisma.order.update({
          where: { id: siblings[0].id },
          data: { packageNumber },
        });
        adopted++;
        console.log(`[sync] Re-keyed ${orderData.orderId}: package "${siblings[0].packageNumber}" → "${packageNumber}"`);
      }
    }

    if (!existing) {
      // Two syncs for the same store can overlap (manual click while the
      // scheduled run is in flight). Let the unique constraint arbitrate and
      // fall through to an update rather than failing the whole sync.
      try {
        await prisma.order.create({
          data: {
            orderId:         orderData.orderId,
            storeId,
            packageNumber,
            buyerName:       orderData.buyerName,
            buyerAddress:    orderData.buyerAddress,
            buyerPhone:      orderData.buyerPhone,
            buyerCity:       orderData.buyerCity,
            buyerProvince:   orderData.buyerProvince,
            buyerPostalCode: orderData.buyerPostalCode,
            buyerNote:       orderData.buyerNote    || null,
            paymentMethod:   orderData.paymentMethod || null,
            items:           JSON.stringify(Array.isArray(orderData.items) ? orderData.items : []),
            shippingCourier: orderData.shippingCourier,
            shippingService: orderData.shippingService,
            trackingNumber:  orderData.trackingNumber,
            logisticsStatus: orderData.logisticsStatus || null,
            logisticsChannelId: orderData.logisticsChannelId ?? null,
            status:          orderData.status,
            orderDate:       orderData.orderDate,
          },
        });
        created++;
        continue;
      } catch (err) {
        if (err.code !== 'P2002') throw err;
        console.warn(`[sync] Concurrent insert for ${orderData.orderId}/${packageNumber || '(default)'} — updating instead`);
      }
    }

    {
      const row = existing || await prisma.order.findUnique({
        where: {
          storeId_orderId_packageNumber: { storeId, orderId: orderData.orderId, packageNumber },
        },
      });
      if (!row) continue;

      await prisma.order.update({
        where: { id: row.id },
        data: {
          status:          orderData.status,
          // Never let a later sync blank out a tracking number or fulfillment
          // state we already have — Shopee omits them while the 3PL catches up.
          logisticsStatus: orderData.logisticsStatus ?? row.logisticsStatus,
          logisticsChannelId: orderData.logisticsChannelId ?? row.logisticsChannelId,
          trackingNumber:  orderData.trackingNumber || row.trackingNumber,
          shippingCourier: orderData.shippingCourier || row.shippingCourier,
          items:           JSON.stringify(Array.isArray(orderData.items) ? orderData.items : []),
          buyerNote:       orderData.buyerNote    ?? row.buyerNote,
          paymentMethod:   orderData.paymentMethod ?? row.paymentMethod,
        },
      });
      updated++;
    }
  }

  if (adopted > 0) {
    console.log(`[sync] Re-keyed ${adopted} row(s) rather than duplicating them`);
  }

  return { created, updated, adopted };
}

/** Local statuses that still expect an operator to act, so drift is expensive. */
// UNPAID belongs here even though nothing can be done to such an order yet.
// Shopee auto-cancels orders the buyer never pays for, and once that happens
// the order stops appearing in the UNPAID pass — so without reconciliation the
// row keeps claiming UNPAID forever, inflating the order count and hiding the
// cancellation.
const ACTIONABLE_STATUSES = ['UNPAID', 'READY_TO_SHIP', 'RETRY_SHIP', 'PROCESSED'];

/** Ceiling on re-reads per sync, so reconciliation cannot dominate the run. */
const RECONCILE_LIMIT = 200;

/**
 * Re-read orders that are still actionable locally but did not come back in
 * this sync run.
 *
 * The main loop only ever writes what Shopee returned, so a row Shopee stopped
 * handing back keeps its old status forever. That happens for two reasons, and
 * both have been seen here:
 *
 *   - A whole status pass fails. `get_order_list` is fetched one status at a
 *     time and a rejection is only warned about, so if the PROCESSED pass falls
 *     over, every order that just moved to PROCESSED is simply missing from the
 *     run — and its row goes on claiming READY_TO_SHIP.
 *   - The order moved to a status nothing fetches, or aged out of the 15-day
 *     create_time window without landing in the update_time passes.
 *
 * Oldest-untouched first, so a backlog is worked through across runs rather
 * than the same head of the list being re-read every time.
 *
 * @param {Object} store
 * @param {string} accessToken
 * @param {Set<string>} seenOrderSns - order_sn values this run already wrote
 * @returns {Promise<number>} How many order_sns were re-read
 */
async function reconcileUnseenShopeeOrders(store, accessToken, seenOrderSns) {
  const rows = await prisma.order.findMany({
    where: { storeId: store.id, status: { in: ACTIONABLE_STATUSES } },
    select: { orderId: true },
    distinct: ['orderId'],
    orderBy: { updatedAt: 'asc' },
  });

  // Filtered here rather than with a `notIn`: the seen set runs to thousands of
  // order_sns on a busy shop, and that becomes an enormous SQL statement.
  const allUnseen = rows.map(r => r.orderId).filter(sn => !seenOrderSns.has(sn));
  const unseen = allUnseen.slice(0, RECONCILE_LIMIT);

  if (unseen.length === 0) return 0;

  const deferred = allUnseen.length - unseen.length;
  console.log(`[sync] Reconciling ${unseen.length} order(s) Shopee did not return this run${
    deferred > 0 ? ` (${deferred} more next run)` : ''}`);

  let reconciled = 0;

  for (let i = 0; i < unseen.length; i += 50) {
    const chunk = unseen.slice(i, i + 50);

    try {
      const resp = await shopeeService.getOrderDetail(accessToken, store.shopId, chunk);
      const details = resp.response?.order_list || [];

      const refreshed = details.flatMap(o => expandShopeeOrderToPackages(o).map(row => ({
        ...row,
        status: row.status || 'READY_TO_SHIP',
      })));

      await backfillShopeeTracking(accessToken, store.shopId, refreshed);
      await upsertOrderRows(store.id, refreshed);

      reconciled += details.length;
    } catch (err) {
      // Best effort by design: the main sync already succeeded, and failing it
      // now would throw away the orders it did write.
      console.warn(`[sync] Reconciliation chunk of ${chunk.length} failed: ${err.message}`);
    }
  }

  console.log(`[sync] Reconciled ${reconciled}/${unseen.length} order(s)`);
  return reconciled;
}

/**
 * Sync a store and record the outcome on the store row.
 *
 * The result has to be persisted: when sync runs on the queue nobody is waiting
 * on the HTTP response, so a failure would otherwise exist only in worker logs
 * and the UI would show an empty order list indistinguishable from success.
 *
 * @param {string} storeId
 * @returns {Promise<{ storeId, total, created, updated }>}
 */
async function syncStore(storeId) {
  // A repeatable job can outlive the store it belongs to: BullMQ keeps firing
  // until the repeat key is removed, and that removal is best-effort (it is
  // skipped entirely when Redis is unreachable). Without this check a store the
  // admin disconnected would go on pulling orders every interval. Skipping is
  // deliberate rather than throwing — a disabled store is not a sync failure,
  // so its recorded sync state is left untouched.
  const state = await prisma.store.findUnique({
    where: { id: storeId },
    select: { isActive: true },
  });

  if (!state) {
    console.warn(`[sync] Store ${storeId} no longer exists — skipping`);
    return { storeId, total: 0, created: 0, updated: 0, skipped: 'missing' };
  }

  if (!state.isActive) {
    console.log(`[sync] Store ${storeId} is deactivated — skipping sync`);
    return { storeId, total: 0, created: 0, updated: 0, skipped: 'inactive' };
  }

  await prisma.store.update({
    where: { id: storeId },
    data: { lastSyncAttemptAt: new Date() },
  }).catch(() => { /* store may have been deleted mid-flight */ });

  try {
    const result = await runStoreSync(storeId);

    // A run that lost a status pass finished, but not completely: the orders in
    // that status were never refreshed. Recording it as a plain OK is what let
    // stale rows accumulate unnoticed, so it gets its own state.
    const partial = Array.isArray(result.warnings) && result.warnings.length > 0;

    if (partial) {
      console.warn(`[sync] Store ${storeId} finished with ${result.warnings.length} incomplete pass(es)`);
    }

    await prisma.store.update({
      where: { id: storeId },
      data: {
        lastSyncStatus: partial ? 'PARTIAL' : 'OK',
        // Column is plain text; keep it short enough to display in a banner
        lastSyncError: partial ? result.warnings.join(' | ').slice(0, 500) : null,
        needsReconnect: false,
      },
    });

    return result;
  } catch (err) {
    const message = err.message || String(err);
    const reconnect = isReconnectError(message);

    console.error(`[sync] Store ${storeId} failed: ${message}${reconnect ? ' (needs reconnect)' : ''}`);

    await prisma.store.update({
      where: { id: storeId },
      data: {
        lastSyncStatus: 'ERROR',
        // Column is plain text; keep it short enough to display in a toast
        lastSyncError: message.slice(0, 500),
        needsReconnect: reconnect,
      },
    }).catch((updateErr) => {
      console.error(`[sync] Could not record failure for store ${storeId}: ${updateErr.message}`);
    });

    throw err;
  }
}

/**
 * BullMQ-compatible job handler wrapper.
 * Call: handleSync(job) where job.data = { storeId }
 */
async function handleSync(job) {
  return syncStore(job.data.storeId);
}

module.exports = {
  syncStore,
  handleSync,
  ensureFreshToken,
  // Exported for testing: the package expansion is the one transformation here
  // that silently changes row counts, so it is worth exercising directly.
  expandShopeeOrderToPackages,
  // Exported for testing: reads a response shape the KB does not document, so
  // its tolerance for variation is worth pinning down.
  extractTrackingResults,
};
