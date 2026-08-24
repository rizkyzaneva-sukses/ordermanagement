'use strict';

/**
 * fulfillment.js — write-side Shopee operations: arranging shipment, retrying a
 * failed pickup, cancelling, and obtaining the official Shopee AWB.
 *
 * Everything here follows shopee-order-management-kb.md. Two of its rules shape
 * the whole module:
 *
 *   Rule #1 — never act on a locally cached status. Every write re-reads the
 *             live order from Shopee first.
 *   Rule #6 — ship_order is not idempotent. A package already in
 *             LOGISTICS_REQUEST_CREATED must not be shipped again.
 */

const fs   = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const prisma        = require('../prisma/client.js');
const shopeeService = require('./shopee.js');
const { ensureFreshToken, expandShopeeOrderToPackages } = require('./syncDirect.js');

const config = require('../config/index.js');

const AWB_DIR = path.join(config.storage.dir, 'awb');

// ── Fulfillment status sets (KB §3.2) ─────────────────────────────────────────

/** Shipment has been arranged; the AWB exists and the parcel is still with us. */
const AWB_PRINTABLE = new Set([
  'LOGISTICS_REQUEST_CREATED',
  'LOGISTICS_PICKUP_RETRY',
]);

/** Shipment not arranged yet — there is nothing to print (KB §7.3). */
const AWB_TOO_EARLY = new Set([
  'LOGISTICS_NOT_START',
  'LOGISTICS_READY',
  'LOGISTICS_PENDING_ARRANGE',
]);

/** Parcel already handed over, delivered, or dead — printing window closed. */
const AWB_TOO_LATE = new Set([
  'LOGISTICS_PICKUP_DONE',
  'LOGISTICS_DELIVERY_DONE',
  'LOGISTICS_DELIVERY_FAILED',
  'LOGISTICS_LOST',
  'LOGISTICS_INVALID',
  'LOGISTICS_REQUEST_CANCELED',
  'LOGISTICS_PICKUP_FAILED',
  'LOGISTICS_COD_REJECTED',
]);

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Create an error carrying an HTTP status so routes can translate it directly
 * instead of every caller re-deriving one from the message.
 */
function fail(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// ── Context loading ───────────────────────────────────────────────────────────

/**
 * Load an order row together with its store and a guaranteed-fresh token.
 *
 * @param {string} orderRowId - Local Order.id (not the Shopee order_sn)
 * @returns {Promise<{ order: Object, store: Object, accessToken: string }>}
 */
async function loadContext(orderRowId) {
  const order = await prisma.order.findUnique({
    where: { id: orderRowId },
    include: { store: true },
  });

  if (!order) throw fail(404, 'Order not found');
  if (!order.store) throw fail(500, `Order ${orderRowId} has no store attached`);
  if (order.store.platform !== 'SHOPEE') {
    throw fail(400, `Fulfillment actions are only supported for Shopee stores (this one is ${order.store.platform})`);
  }

  const accessToken = await ensureFreshToken(order.store);
  return { order, store: order.store, accessToken };
}

/**
 * Re-read the authoritative order and package state from Shopee (KB Rule #1).
 *
 * @param {Object} ctx - From loadContext
 * @returns {Promise<{ orderStatus: string, logisticsStatus: string|null, trackingNumber: string|null, itemList: Array }>}
 */
async function fetchLiveState(ctx) {
  const { order, store, accessToken } = ctx;

  const resp = await shopeeService.getOrderDetail(accessToken, store.shopId, [order.orderId]);
  const detail = resp.response?.order_list?.[0];

  if (!detail) {
    throw fail(404, `Shopee has no order ${order.orderId} for this shop`);
  }

  const packages = Array.isArray(detail.package_list) ? detail.package_list : [];
  // Match the specific package this row represents; a single-package order has
  // an empty packageNumber locally and exactly one entry here.
  const pkg = order.packageNumber
    ? packages.find(p => String(p.package_number || '') === order.packageNumber)
    : packages[0];

  let logisticsStatus = pkg?.logistics_status || null;
  let isShipmentArranged = null;

  // get_package_detail is the authoritative per-package read (KB Rule #1
  // sanctions either endpoint), and the only source of `is_shipment_arranged`.
  //
  // That flag matters more than it looks. Shopee's own ship_order FAQ warns that
  // fulfillment_status lags: a package whose shipment was just arranged can
  // still report LOGISTICS_READY for a while, and shipping it again on the
  // strength of that is a guaranteed rejection. Their stated rule is to ship
  // only when fulfillment_status is LOGISTICS_READY *and* is_shipment_arranged
  // is false. Those wasted calls count against the ship_order success rate
  // Shopee holds us to, so the read is worth an extra request on a write path.
  //
  // Called for every order with a package number, not just split ones — the
  // number itself is valid either way, it is only ship_order that refuses it
  // for an unsplit order (see packageNumberForLogistics).
  if (order.packageNumber) {
    try {
      const pkgResp = await shopeeService.getPackageDetail(accessToken, store.shopId, [order.packageNumber]);
      const pkgDetail = pkgResp.response?.package_list?.[0] || pkgResp.response?.[0];

      // Shopee names it fulfillment_status here and logistics_status elsewhere
      const pkgStatus = pkgDetail?.fulfillment_status || pkgDetail?.logistics_status;
      if (pkgStatus) {
        if (pkgStatus !== logisticsStatus) {
          console.log(`[fulfillment] ${order.orderId}/${order.packageNumber}: package detail reports ${pkgStatus} (order detail said ${logisticsStatus || 'nothing'})`);
        }
        logisticsStatus = pkgStatus;
      }

      if (typeof pkgDetail?.is_shipment_arranged === 'boolean') {
        isShipmentArranged = pkgDetail.is_shipment_arranged;
      }
    } catch (err) {
      console.warn(`[fulfillment] get_package_detail unavailable for ${order.packageNumber}, using order detail: ${err.message}`);
    }
  }

  return {
    orderStatus:     detail.order_status || null,
    logisticsStatus,
    // null when Shopee did not tell us — treated as "unknown", never as "false"
    isShipmentArranged,
    trackingNumber:  detail.tracking_number || null,
    itemList:        detail.item_list || [],
    packageCount:    packages.length,
    raw:             detail,
  };
}

/**
 * Whether a package has already had its shipment arranged.
 *
 * `is_shipment_arranged` is authoritative when Shopee supplies it; the
 * fulfillment status is the fallback for when it does not.
 *
 * @param {Object} live - fetchLiveState result
 * @returns {boolean}
 */
function shipmentAlreadyArranged(live) {
  // Either signal saying "arranged" is enough. A false flag is not allowed to
  // override a status that is plainly past the shipping stage.
  const byStatus = Boolean(live.logisticsStatus) && !AWB_TOO_EARLY.has(live.logisticsStatus);
  return live.isShipmentArranged === true || byStatus;
}

// ── package_number gating ─────────────────────────────────────────────────────

/**
 * Count how many local package rows exist per order_sn.
 *
 * @param {string} storeId
 * @param {string[]} orderSns
 * @returns {Promise<Map<string, number>>}
 */
async function countPackageRows(storeId, orderSns) {
  const rows = await prisma.order.findMany({
    where: { storeId, orderId: { in: [...new Set(orderSns)] } },
    select: { orderId: true },
  });

  const counts = new Map();
  for (const row of rows) counts.set(row.orderId, (counts.get(row.orderId) || 0) + 1);
  return counts;
}

/**
 * The `package_number` to send on a logistics call, or `undefined`.
 *
 * get_order_detail returns a package_number even for an order that was never
 * split, and the sync stores it — but Shopee rejects that number on ship_order
 * ("Please don't request with package_number for this unsplit order"). Since an
 * unsplit order has exactly one package, omitting the number targets the same
 * package and is accepted everywhere, so it is only ever sent for a genuine
 * split.
 *
 * @param {Object} order - Local order row
 * @param {Object} [live] - fetchLiveState result; authoritative when present
 * @returns {Promise<string|undefined>}
 */
async function packageNumberForLogistics(order, live) {
  if (!order.packageNumber) return undefined;

  if (live && typeof live.packageCount === 'number' && live.packageCount > 0) {
    return live.packageCount > 1 ? order.packageNumber : undefined;
  }

  const counts = await countPackageRows(order.storeId, [order.orderId]);
  return (counts.get(order.orderId) || 1) > 1 ? order.packageNumber : undefined;
}

/**
 * Persist whatever the live read told us, so the local row stops drifting even
 * when the action itself fails.
 */
async function syncRowFromLiveState(orderRowId, live, extra = {}) {
  const data = { ...extra };
  if (live.orderStatus)     data.status = live.orderStatus;
  if (live.logisticsStatus) data.logisticsStatus = live.logisticsStatus;
  if (live.trackingNumber)  data.trackingNumber = live.trackingNumber;

  if (Object.keys(data).length === 0) return null;
  return prisma.order.update({ where: { id: orderRowId }, data });
}

// ── Shipping ──────────────────────────────────────────────────────────────────

/**
 * Fetch the shipping modes and pickup options Shopee will accept for a package.
 *
 * Feeds the UI so an operator can choose an address and time slot before
 * committing to `arrangeShipment`.
 *
 * @param {string} orderRowId
 * @returns {Promise<Object>}
 */
async function getShippingOptions(orderRowId) {
  const ctx = await loadContext(orderRowId);
  const live = await fetchLiveState(ctx);
  await syncRowFromLiveState(orderRowId, live);

  // The live state was already read above but went unchecked, so a package Shopee
  // considers unshippable produced its raw rejection ("Shipping parameters can
  // only be obtained when package is ready to be shipped") with no indication of
  // which state was actually the problem. arrangeShipment guards on the same
  // conditions; this is the read-only step that precedes it.
  if (live.orderStatus && !['READY_TO_SHIP', 'RETRY_SHIP'].includes(live.orderStatus)) {
    const hint = live.orderStatus === 'PROCESSED'
      ? ' — pengirimannya sudah diatur sebelumnya'
      : ' — pengiriman hanya bisa diatur saat READY_TO_SHIP atau RETRY_SHIP';
    throw fail(409, `Pesanan berstatus ${live.orderStatus} di Shopee${hint}. Status di daftar sudah diperbarui.`);
  }

  if (shipmentAlreadyArranged(live)) {
    throw fail(409, `Pengiriman paket ini sudah diatur sebelumnya (${live.logisticsStatus || 'is_shipment_arranged'}) — tidak perlu diatur ulang`);
  }

  // Same LOGISTICS_READY rule as arrangeShipment, checked here so the dialog
  // explains itself instead of opening a form Shopee will reject.
  if (live.logisticsStatus && live.logisticsStatus !== 'LOGISTICS_READY') {
    throw fail(409, `Paket belum siap dikirim (${live.logisticsStatus}) — tunggu sampai Shopee menandainya siap diatur`);
  }

  const pkgNumber = await packageNumberForLogistics(ctx.order, live);

  const resp = await shopeeService.getShippingParameter(
    ctx.accessToken, ctx.store.shopId, ctx.order.orderId, pkgNumber);

  const infoNeeded = resp.response?.info_needed || {};
  // A mode is on offer when its key is present, whatever the array holds — an
  // empty one means "no extra fields needed", not "unavailable".
  const available = ['pickup', 'dropoff', 'non_integrated']
    .filter(m => Object.prototype.hasOwnProperty.call(infoNeeded, m));

  // Logged because an empty info_needed is otherwise invisible: the dialog just
  // shows every mode greyed out with nothing to explain why Shopee offered none.
  console.log(`[fulfillment] Shipping options ${ctx.order.orderId} pkg=${pkgNumber || '(default)'} courier=${ctx.order.shippingCourier || '-'} info_needed=${JSON.stringify(infoNeeded)}`);

  return {
    orderStatus:     live.orderStatus,
    logisticsStatus: live.logisticsStatus,
    availableModes:  available,
    suggestedMode:   available[0] || null,
    infoNeeded,
    pickup:          resp.response?.pickup || null,
    dropoff:         resp.response?.dropoff || null,
    slug:            resp.response?.slug || null,
  };
}

/**
 * Arrange shipment for one package.
 *
 * Refuses to act unless Shopee currently reports the order as shippable, and
 * short-circuits when the package has already been arranged (KB Rule #6) —
 * in that case it only refreshes the tracking number.
 *
 * @param {string} orderRowId
 * @param {Object} [options={}]
 * @param {'pickup'|'dropoff'|'non_integrated'} [options.mode] - Auto-selected when omitted
 * @param {Object} [options.modeData={}]
 * @param {string} [options.userId] - Recorded as the operator who processed it
 * @param {boolean} [options.pollTracking=true] - Wait for the tracking number.
 *   Turned off for bulk runs, where five polls per order would dominate the
 *   whole operation; the next sync fills the numbers in instead.
 * @returns {Promise<Object>}
 */
async function arrangeShipment(orderRowId, options = {}) {
  const pollTracking = options.pollTracking !== false;
  const ctx = await loadContext(orderRowId);
  const live = await fetchLiveState(ctx);
  await syncRowFromLiveState(orderRowId, live);

  const pkgNumber = await packageNumberForLogistics(ctx.order, live);

  // KB Rule #6 plus Shopee's own guidance: a second ship_order on an arranged
  // package is a guaranteed rejection, and rejections count against us.
  if (shipmentAlreadyArranged(live)) {
    if (AWB_TOO_LATE.has(live.logisticsStatus) && live.logisticsStatus !== 'LOGISTICS_PICKUP_RETRY') {
      throw fail(409, `Package is already past the shipping stage (${live.logisticsStatus})`);
    }

    console.log(`[fulfillment] ${ctx.order.orderId} already arranged (status=${live.logisticsStatus || 'unknown'} is_shipment_arranged=${live.isShipmentArranged}) — refreshing tracking only`);
    const tracking = pollTracking
      ? await shopeeService.pollTrackingNumber(ctx.accessToken, ctx.store.shopId, ctx.order.orderId, pkgNumber)
      : live.trackingNumber;

    const updated = await syncRowFromLiveState(orderRowId, live, tracking ? { trackingNumber: tracking } : {});
    return { alreadyArranged: true, logisticsStatus: live.logisticsStatus, trackingNumber: tracking, order: updated };
  }

  if (live.orderStatus && !['READY_TO_SHIP', 'RETRY_SHIP'].includes(live.orderStatus)) {
    throw fail(409, `Order status is ${live.orderStatus}; only READY_TO_SHIP or RETRY_SHIP can be shipped`);
  }

  // Shopee only accepts ship_order at LOGISTICS_READY. Sending it while the
  // package is still LOGISTICS_NOT_START or being allocated comes back as
  // "Package is not ready to ship" / "The order is being allocated" — avoidable
  // rejections that drag down the ship_order success rate Shopee measures us on.
  if (live.logisticsStatus && live.logisticsStatus !== 'LOGISTICS_READY') {
    throw fail(409, `Paket belum siap dikirim (${live.logisticsStatus}) — Shopee baru menerima pengaturan pengiriman saat status paket LOGISTICS_READY`);
  }

  const paramResp = await shopeeService.getShippingParameter(
    ctx.accessToken, ctx.store.shopId, ctx.order.orderId, pkgNumber);

  const infoNeeded = paramResp.response?.info_needed || {};
  const mode = options.mode || shopeeService.pickShippingMode(infoNeeded);

  if (!Object.prototype.hasOwnProperty.call(infoNeeded, mode)) {
    throw fail(400, `Channel does not accept mode "${mode}" (accepts: ${Object.keys(infoNeeded).join(', ') || 'none'})`);
  }

  await shopeeService.shipOrder(ctx.accessToken, ctx.store.shopId, {
    orderSn:       ctx.order.orderId,
    packageNumber: pkgNumber,
    mode,
    modeData:      options.modeData || {},
    slug:          paramResp.response?.slug || undefined,
  });

  // The tracking number often lags the ship_order call (KB §9)
  const trackingNumber = pollTracking
    ? await shopeeService.pollTrackingNumber(ctx.accessToken, ctx.store.shopId, ctx.order.orderId, pkgNumber)
    : null;

  const updated = await prisma.order.update({
    where: { id: orderRowId },
    data: {
      status:          'PROCESSED',
      // KB §5.2: non_integrated skips straight to pickup-done
      logisticsStatus: mode === 'non_integrated' ? 'LOGISTICS_PICKUP_DONE' : 'LOGISTICS_REQUEST_CREATED',
      trackingNumber:  trackingNumber || ctx.order.trackingNumber,
      processedAt:     new Date(),
      ...(options.userId ? { processedById: options.userId } : {}),
    },
  });

  console.log(`[fulfillment] Shipped ${ctx.order.orderId} pkg=${ctx.order.packageNumber || '(default)'} mode=${mode} tracking=${trackingNumber || '(pending)'}`);

  return { alreadyArranged: false, mode, trackingNumber, order: updated };
}

/**
 * Split a selection into batches that can share one set of shipping answers.
 *
 * A pickup time slot belongs to one courier's own schedule, and the pickup
 * address is a setting of one shop — so a selection spanning either cannot be
 * shipped with a single answer. Sending SiCepat's slot id along with an SPX
 * package is what Shopee rejects as "Pickup time is out of range".
 *
 * Keyed on the logistics channel where it is known. Rows synced before that
 * column existed, and those whose package list Shopee did not break down, have
 * none — the courier name is the fallback, since that is the distinction the
 * schedule actually follows.
 *
 * @param {Array<Object>} rows - Order rows including their store
 * @returns {Array<{key, storeId, storeName, courier, logisticsChannelId, orderRowIds}>}
 */
function groupRowsForShipping(rows) {
  const groups = new Map();

  for (const row of rows) {
    const courier = row.shippingCourier || 'Tanpa kurir';
    const channelKey = row.logisticsChannelId != null
      ? `ch:${row.logisticsChannelId}`
      : `name:${courier.toLowerCase()}`;
    const key = `${row.storeId}|${channelKey}`;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        storeId:            row.storeId,
        storeName:          row.store?.name || 'Toko',
        courier,
        logisticsChannelId: row.logisticsChannelId ?? null,
        orderRowIds:        [],
      });
    }
    groups.get(key).orderRowIds.push(row.id);
  }

  return [...groups.values()];
}

/**
 * Shipping modes, pickup addresses and time slots for a bulk shipment, one set
 * per courier and shop.
 *
 * This used to return a single answer taken from whichever order replied first,
 * and that answer was then applied to the whole selection — so a mixed-courier
 * batch had one courier's slot forced onto all of them, and every other courier
 * was rejected.
 *
 * A group that cannot answer does not sink the dialog: the selection easily
 * contains an order Shopee has moved on since the list was loaded. Each group
 * gets a few attempts, and one that still refuses is returned carrying its
 * reason so the operator can see which courier is stuck and why.
 *
 * @param {string[]} orderRowIds
 * @returns {Promise<{groups: Object[]}>}
 */
async function getMassShippingOptions(orderRowIds) {
  if (!Array.isArray(orderRowIds) || orderRowIds.length === 0) {
    throw fail(400, 'orderRowIds must be a non-empty array');
  }

  const rows = await prisma.order.findMany({
    where: { id: { in: orderRowIds } },
    include: { store: { select: { id: true, name: true } } },
  });

  if (rows.length === 0) throw fail(404, 'No orders found');

  const MAX_ATTEMPTS = 3;
  const groups = [];
  let lastError = null;

  for (const group of groupRowsForShipping(rows)) {
    let options = null;
    let groupError = null;

    for (const orderRowId of group.orderRowIds.slice(0, MAX_ATTEMPTS)) {
      try {
        options = await getShippingOptions(orderRowId);
        break;
      } catch (err) {
        console.warn(`[fulfillment] Mass shipping options: ${orderRowId} (${group.courier}) could not answer (${err.message})`);
        groupError = err;
        lastError = err;
      }
    }

    // Two different dead ends, and they need different words. Shopee refusing
    // to answer is a transient problem worth retrying; Shopee answering with no
    // mode at all is the channel saying this package cannot be arranged through
    // the API, which no amount of retrying will change.
    const answeredWithNothing = options && options.availableModes.length === 0;

    groups.push(options
      ? {
        ...group,
        availableModes: options.availableModes,
        suggestedMode:  options.suggestedMode,
        infoNeeded:     options.infoNeeded,
        pickup:         options.pickup,
        dropoff:        options.dropoff,
        ...(answeredWithNothing
          ? { error: 'Shopee tidak menawarkan cara pengiriman apa pun untuk kurir ini — atur lewat Seller Centre' }
          : {}),
      }
      : {
        ...group,
        availableModes: [],
        suggestedMode:  null,
        error:          groupError?.message || 'Tidak bisa mengambil opsi pengiriman',
      });
  }

  // Nothing at all could be arranged — a failure worth surfacing as one, rather
  // than an empty dialog the operator has to interpret. The reason comes from
  // the groups themselves, so it says which courier and why.
  if (groups.every((g) => g.availableModes.length === 0)) {
    const reasons = [...new Set(groups.map((g) => `${g.courier}: ${g.error}`))].join(' | ');
    throw lastError || fail(409, `Tidak ada pesanan terpilih yang bisa diatur pengirimannya — ${reasons}`);
  }

  return { groups };
}

/**
 * Arrange shipment for many packages.
 *
 * Runs the single-package flow once per order instead of calling
 * `mass_ship_order`. Shopee rejects our batch payload with "package_list is a
 * required field": its batch endpoints want a per-order `package_list` whose
 * exact shape we have not been able to confirm, and guessing at it on a live
 * shop costs a whole selection per attempt. The single-order endpoints are the
 * ones the KB documents and the ones already working here.
 *
 * The loop also removes the all-or-nothing failure mode that made this visible:
 * one malformed field used to take down every order in the batch, which is
 * exactly what happened. Now each order reports its own verdict.
 *
 * Sequential on purpose — fifty parallel ship_order calls against one shop is a
 * good way to meet Shopee's rate limiter.
 *
 * @param {string[]} orderRowIds
 * @param {Object} [options={}]
 * @param {'pickup'|'dropoff'|'non_integrated'} [options.mode]
 * @param {Object} [options.modeData={}] - Required for pickup (address_id,
 *   pickup_time_id) and non_integrated (tracking_number)
 * @param {string} [options.userId]
 * @returns {Promise<{ shipped: Object[], failed: Object[] }>}
 */
async function massArrangeShipment(orderRowIds, options = {}) {
  // Each batch carries its own mode and schedule. The flat form is still
  // accepted — a single-courier selection has nothing to split.
  const batches = Array.isArray(options.groups) && options.groups.length > 0
    ? options.groups.map((g) => ({
      ids:      Array.isArray(g.ids) ? g.ids : [],
      mode:     g.mode,
      modeData: g.modeData || {},
    }))
    : [{ ids: orderRowIds, mode: options.mode, modeData: options.modeData || {} }];

  const allIds = batches.flatMap((b) => b.ids);
  if (allIds.length === 0) {
    throw fail(400, 'orderRowIds must be a non-empty array');
  }
  if (allIds.length > 50) {
    throw fail(400, 'At most 50 packages can be shipped in one request');
  }

  const rows = await prisma.order.findMany({
    where: { id: { in: allIds } },
    include: { store: true },
  });

  if (rows.length === 0) throw fail(404, 'No orders found');

  const byId = new Map(rows.map((r) => [r.id, r]));

  const foreign = rows.filter((r) => r.store.platform !== 'SHOPEE');
  if (foreign.length > 0) {
    throw fail(400, `Mass ship is only supported for Shopee stores (found ${foreign[0].store.platform})`);
  }

  // The single-store rule is gone: it guarded a shared pickup address that no
  // longer exists, now that every batch brings its own. Batches are still
  // built per shop upstream, so nothing here mixes addresses.

  const shipped = [];
  const failed = [];
  const modesUsed = new Set();

  for (const batch of batches) {
    for (const id of batch.ids) {
      const row = byId.get(id);
      if (!row) {
        failed.push({ orderId: id, message: 'Pesanan tidak ditemukan' });
        continue;
      }
      try {
        const result = await arrangeShipment(id, {
          mode:         batch.mode,
          modeData:     batch.modeData,
          userId:       options.userId,
          pollTracking: false,
        });
        if (result.mode) modesUsed.add(result.mode);
        shipped.push({
          id,
          orderId: row.orderId,
          alreadyArranged: Boolean(result.alreadyArranged),
        });
      } catch (err) {
        failed.push({ orderId: row.orderId, message: err.message });
      }
    }
  }

  console.log(`[fulfillment] Mass ship: ${shipped.length} shipped, ${failed.length} rejected across ${batches.length} batch(es)`);

  return {
    mode: [...modesUsed].join('+') || null,
    shipped,
    failed,
  };
}

/**
 * Re-arrange a pickup that the 3PL failed to complete (KB §3.3 transition 9).
 *
 * @param {string} orderRowId
 * @param {Object} options
 * @param {number} options.addressId
 * @param {string} options.pickupTimeId
 * @returns {Promise<Object>}
 */
async function retryShipment(orderRowId, { addressId, pickupTimeId } = {}) {
  const ctx = await loadContext(orderRowId);
  const live = await fetchLiveState(ctx);
  await syncRowFromLiveState(orderRowId, live);

  const retryable = live.orderStatus === 'RETRY_SHIP' || live.logisticsStatus === 'LOGISTICS_PICKUP_RETRY';
  if (!retryable) {
    throw fail(409, `Order is not awaiting a pickup retry (status=${live.orderStatus}, logistics=${live.logisticsStatus})`);
  }

  await shopeeService.updateShippingOrder(ctx.accessToken, ctx.store.shopId, {
    orderSn:       ctx.order.orderId,
    packageNumber: await packageNumberForLogistics(ctx.order, live),
    addressId,
    pickupTimeId,
  });

  const updated = await prisma.order.update({
    where: { id: orderRowId },
    data: { status: 'PROCESSED', logisticsStatus: 'LOGISTICS_REQUEST_CREATED' },
  });

  console.log(`[fulfillment] Pickup re-arranged for ${ctx.order.orderId} address=${addressId} slot=${pickupTimeId}`);
  return { order: updated };
}

// ── Split / unsplit (KB §6) ───────────────────────────────────────────────────

/** Non-TW markets cap a split at 5 packages; TW allows 30 (KB §6 rule 5). */
const MAX_SPLIT_PACKAGES = 5;

/**
 * Rebuild the local package rows for one order straight from Shopee.
 *
 * A split replaces one row with several and an unsplit does the reverse, so the
 * rows have to be re-derived rather than patched. Rows that no longer exist
 * upstream are removed, except any that carry print history.
 */
async function resyncOrderPackages(store, orderSn, accessToken) {
  const resp = await shopeeService.getOrderDetail(accessToken, store.shopId, [orderSn]);
  const detail = resp.response?.order_list?.[0];
  if (!detail) return { created: 0, updated: 0, removed: 0 };

  const rows = expandShopeeOrderToPackages(detail);
  const existing = await prisma.order.findMany({ where: { storeId: store.id, orderId: orderSn } });

  let created = 0;
  let updated = 0;

  for (const row of rows) {
    const packageNumber = row.packageNumber || '';
    const match = existing.find(e => e.packageNumber === packageNumber);

    const data = {
      status:             row.status || 'READY_TO_SHIP',
      logisticsStatus:    row.logisticsStatus || null,
      logisticsChannelId: row.logisticsChannelId ?? null,
      shippingCourier:    row.shippingCourier || '',
      shippingService:    row.shippingService || '',
      trackingNumber:     row.trackingNumber || null,
      items:              JSON.stringify(row.items || []),
    };

    if (match) {
      await prisma.order.update({ where: { id: match.id }, data });
      updated++;
    } else {
      await prisma.order.create({
        data: {
          ...data,
          orderId:         orderSn,
          storeId:         store.id,
          packageNumber,
          buyerName:       row.buyerName,
          buyerAddress:    row.buyerAddress,
          buyerPhone:      row.buyerPhone,
          buyerCity:       row.buyerCity,
          buyerProvince:   row.buyerProvince,
          buyerPostalCode: row.buyerPostalCode,
          buyerNote:       row.buyerNote || null,
          paymentMethod:   row.paymentMethod || null,
          orderDate:       row.orderDate,
        },
      });
      created++;
    }
  }

  const livePackages = new Set(rows.map(r => r.packageNumber || ''));
  const orphans = existing.filter(e => !livePackages.has(e.packageNumber));

  // A printed row is kept even when Shopee no longer lists the package, so the
  // print history is not silently destroyed.
  const removable = orphans.filter(o => !o.printedAt);
  if (orphans.length > removable.length) {
    console.warn(`[fulfillment] ${orphans.length - removable.length} stale package row(s) for ${orderSn} kept because they were already printed`);
  }

  if (removable.length > 0) {
    await prisma.order.deleteMany({ where: { id: { in: removable.map(o => o.id) } } });
  }

  console.log(`[fulfillment] Resynced ${orderSn}: ${created} created, ${updated} updated, ${removable.length} removed`);
  return { created, updated, removed: removable.length };
}

/**
 * Items of an order plus the grouping constraints that limit how it may split.
 *
 * Feeds the UI so an operator is not offered splits Shopee will reject.
 *
 * @param {string} orderRowId
 * @returns {Promise<Object>}
 */
async function getSplitOptions(orderRowId) {
  const ctx = await loadContext(orderRowId);
  const live = await fetchLiveState(ctx);
  await syncRowFromLiveState(orderRowId, live);

  const items = live.itemList.map(i => ({
    itemId:           i.item_id,
    modelId:          i.model_id || 0,
    orderItemId:      i.order_item_id ?? i.item_id,
    promotionGroupId: i.promotion_group_id ?? 0,
    addOnDealId:      i.add_on_deal_id ?? 0,
    name:             i.item_name || 'Product',
    variant:          i.model_name || null,
    quantity:         i.model_quantity_purchased || 1,
  }));

  // Items sharing an orderItemId are one bundle deal; sharing an addOnDealId are
  // one add-on deal. Neither may straddle two packages (KB §6 rules 2–3).
  const groups = new Map();
  for (const item of items) {
    const key = item.addOnDealId
      ? `addon:${item.addOnDealId}`
      : `bundle:${item.orderItemId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const lockedGroups = [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => ({
      key,
      reason: key.startsWith('addon') ? 'add-on deal' : 'bundle deal',
      itemIds: members.map(m => m.itemId),
    }));

  return {
    orderStatus: live.orderStatus,
    splittable: live.orderStatus === 'READY_TO_SHIP',
    maxPackages: MAX_SPLIT_PACKAGES,
    items,
    lockedGroups,
  };
}

/**
 * Validate a proposed split against the KB §6 rules before sending it.
 *
 * Returns the list of violations rather than throwing on the first one, so the
 * UI can show everything that is wrong at once.
 *
 * @param {Array<{items: Array}>} packages - Proposed packages
 * @param {Array} allItems - Every item on the order
 * @returns {string[]} Violations, empty when the split is legal
 */
function validateSplit(packages, allItems) {
  const problems = [];

  if (!Array.isArray(packages) || packages.length < 2) {
    problems.push('A split needs at least 2 packages');
    return problems;
  }
  if (packages.length > MAX_SPLIT_PACKAGES) {
    problems.push(`At most ${MAX_SPLIT_PACKAGES} packages are allowed`);
  }
  if (packages.some(p => !Array.isArray(p.items) || p.items.length === 0)) {
    problems.push('Every package must contain at least one item');
  }

  const keyOf = (i) => `${i.itemId}::${i.modelId || 0}::${i.orderItemId ?? i.itemId}`;

  const assigned = packages.flatMap(p => p.items || []);
  const assignedKeys = assigned.map(keyOf);
  const expectedKeys = allItems.map(keyOf);

  const duplicates = assignedKeys.filter((k, i) => assignedKeys.indexOf(k) !== i);
  if (duplicates.length > 0) {
    problems.push('An item was placed in more than one package');
  }

  const missing = expectedKeys.filter(k => !assignedKeys.includes(k));
  if (missing.length > 0) {
    problems.push(`The split must include every item on the order (${missing.length} missing)`);
  }

  // Bundle and add-on deals must stay together (KB §6 rules 2–3)
  const groupLocation = new Map();
  packages.forEach((pkg, index) => {
    for (const item of pkg.items || []) {
      const groupKey = item.addOnDealId
        ? `addon:${item.addOnDealId}`
        : `bundle:${item.orderItemId ?? item.itemId}`;

      const seenAt = groupLocation.get(groupKey);
      if (seenAt !== undefined && seenAt !== index) {
        const label = groupKey.startsWith('addon') ? 'An add-on deal' : 'A bundle deal';
        const message = `${label} was split across packages, which Shopee does not allow`;
        if (!problems.includes(message)) problems.push(message);
      } else {
        groupLocation.set(groupKey, index);
      }
    }
  });

  return problems;
}

/**
 * Split an order into packages.
 *
 * @param {string} orderRowId
 * @param {Array<{items: Array}>} packages
 * @returns {Promise<Object>}
 */
async function splitOrder(orderRowId, packages) {
  const ctx = await loadContext(orderRowId);
  const live = await fetchLiveState(ctx);
  await syncRowFromLiveState(orderRowId, live);

  if (live.orderStatus !== 'READY_TO_SHIP') {
    throw fail(409, `Order status is ${live.orderStatus}; only READY_TO_SHIP orders can be split (KB §6)`);
  }

  const allItems = live.itemList.map(i => ({
    itemId:      i.item_id,
    modelId:     i.model_id || 0,
    orderItemId: i.order_item_id ?? i.item_id,
    addOnDealId: i.add_on_deal_id ?? 0,
  }));

  const problems = validateSplit(packages, allItems);
  if (problems.length > 0) {
    throw fail(400, problems.join('; '));
  }

  const payload = packages.map(pkg => ({
    item_list: pkg.items.map(item => ({
      item_id:            item.itemId,
      model_id:           item.modelId || 0,
      order_item_id:      item.orderItemId ?? item.itemId,
      promotion_group_id: item.promotionGroupId ?? 0,
    })),
  }));

  await shopeeService.splitOrder(ctx.accessToken, ctx.store.shopId, ctx.order.orderId, payload);

  const resync = await resyncOrderPackages(ctx.store, ctx.order.orderId, ctx.accessToken);

  console.log(`[fulfillment] Split ${ctx.order.orderId} into ${packages.length} package(s)`);
  return { orderId: ctx.order.orderId, packages: packages.length, ...resync };
}

/**
 * Merge a previously split order back into one package.
 *
 * @param {string} orderRowId
 * @returns {Promise<Object>}
 */
async function unsplitOrder(orderRowId) {
  const ctx = await loadContext(orderRowId);
  const live = await fetchLiveState(ctx);
  await syncRowFromLiveState(orderRowId, live);

  if (live.orderStatus !== 'READY_TO_SHIP') {
    throw fail(409, `Order status is ${live.orderStatus}; a split can only be undone while READY_TO_SHIP (KB §6 rule 7)`);
  }

  await shopeeService.unsplitOrder(ctx.accessToken, ctx.store.shopId, ctx.order.orderId);

  const resync = await resyncOrderPackages(ctx.store, ctx.order.orderId, ctx.accessToken);

  console.log(`[fulfillment] Unsplit ${ctx.order.orderId}`);
  return { orderId: ctx.order.orderId, ...resync };
}

// ── Cancellation ──────────────────────────────────────────────────────────────

/**
 * Cancel an order as the seller.
 *
 * `OUT_OF_STOCK` needs the affected items; when the caller does not supply them
 * we take every item on the order, which is what cancelling the whole order means.
 *
 * @param {string} orderRowId
 * @param {Object} options
 * @param {'OUT_OF_STOCK'|'UNDELIVERABLE_AREA'} options.reason
 * @param {Array} [options.itemList]
 * @returns {Promise<Object>}
 */
async function cancelOrder(orderRowId, { reason, itemList } = {}) {
  const ctx = await loadContext(orderRowId);
  const live = await fetchLiveState(ctx);
  await syncRowFromLiveState(orderRowId, live);

  if (!['READY_TO_SHIP', 'PROCESSED', 'UNPAID'].includes(live.orderStatus)) {
    throw fail(409, `Order status is ${live.orderStatus}; it can no longer be cancelled by the seller`);
  }

  let items = itemList;
  if (reason === 'OUT_OF_STOCK' && (!Array.isArray(items) || items.length === 0)) {
    items = live.itemList.map(i => ({ item_id: i.item_id, model_id: i.model_id || 0 }));
    if (items.length === 0) {
      throw fail(400, 'Cannot cancel for OUT_OF_STOCK: Shopee returned no items for this order');
    }
  }

  await shopeeService.cancelOrder(ctx.accessToken, ctx.store.shopId, ctx.order.orderId, reason, items);

  // Every package of the order dies with it, not just this row
  await prisma.order.updateMany({
    where: { storeId: ctx.store.id, orderId: ctx.order.orderId },
    data: { status: 'CANCELLED', cancelReason: reason, isBatchSelected: false },
  });

  console.log(`[fulfillment] Cancelled ${ctx.order.orderId} reason=${reason}`);
  return { orderId: ctx.order.orderId, reason };
}

/**
 * Approve or reject a buyer's cancellation request.
 *
 * Silence counts as approval on Shopee's side (KB §2.2), so a rejection has to
 * be sent explicitly and before the window closes.
 *
 * @param {string} orderRowId
 * @param {'ACCEPT'|'REJECT'} operation
 * @returns {Promise<Object>}
 */
async function respondToCancellation(orderRowId, operation) {
  const ctx = await loadContext(orderRowId);
  const live = await fetchLiveState(ctx);
  await syncRowFromLiveState(orderRowId, live);

  if (live.orderStatus !== 'IN_CANCEL') {
    throw fail(409, `Order status is ${live.orderStatus}; there is no pending buyer cancellation to answer`);
  }

  await shopeeService.handleBuyerCancellation(ctx.accessToken, ctx.store.shopId, ctx.order.orderId, operation);

  // A rejection returns the order to its previous status, which only Shopee
  // knows — re-read instead of guessing (KB Rule #1).
  const after = await fetchLiveState(ctx);
  await prisma.order.updateMany({
    where: { storeId: ctx.store.id, orderId: ctx.order.orderId },
    data: {
      status: after.orderStatus || (operation === 'ACCEPT' ? 'CANCELLED' : live.orderStatus),
      ...(operation === 'ACCEPT' ? { cancelReason: 'BUYER_REQUEST', isBatchSelected: false } : {}),
    },
  });

  console.log(`[fulfillment] ${operation === 'ACCEPT' ? 'Accepted' : 'Rejected'} buyer cancellation for ${ctx.order.orderId}`);
  return { orderId: ctx.order.orderId, operation, status: after.orderStatus };
}

// ── Tracking ──────────────────────────────────────────────────────────────────

/**
 * Pull the tracking number for one package on demand.
 *
 * @param {string} orderRowId
 * @returns {Promise<{ trackingNumber: string|null }>}
 */
async function refreshTracking(orderRowId) {
  const ctx = await loadContext(orderRowId);

  const resp = await shopeeService.getTrackingNumber(
    ctx.accessToken, ctx.store.shopId, ctx.order.orderId,
    await packageNumberForLogistics(ctx.order));

  const trackingNumber = resp.response?.tracking_number || null;

  if (trackingNumber && trackingNumber !== ctx.order.trackingNumber) {
    await prisma.order.update({
      where: { id: orderRowId },
      data: { trackingNumber },
    });
  }

  return { trackingNumber };
}

/**
 * Pull the tracking number for many packages at once.
 *
 * The per-order call existed, but a print run stuck on twenty missing waybills
 * left the operator opening twenty menus or waiting out the next 15-minute
 * sync. Sequential on purpose — twenty parallel calls against one shop is how
 * you meet Shopee's rate limiter.
 *
 * One package failing is normal here: the courier simply may not have issued a
 * number yet. Each is reported on its own rather than taking down the run.
 *
 * @param {string[]} orderRowIds
 * @returns {Promise<{ refreshed: Array, stillMissing: Array, failed: Array }>}
 */
async function refreshTrackingMany(orderRowIds) {
  if (!Array.isArray(orderRowIds) || orderRowIds.length === 0) {
    throw fail(400, 'orderRowIds must be a non-empty array');
  }
  if (orderRowIds.length > 100) {
    throw fail(400, 'At most 100 packages can be refreshed in one request');
  }

  const rows = await prisma.order.findMany({
    where: { id: { in: orderRowIds } },
    select: { id: true, orderId: true },
  });
  const orderIdOf = new Map(rows.map((r) => [r.id, r.orderId]));

  const refreshed = [];
  const stillMissing = [];
  const failed = [];

  for (const id of orderRowIds) {
    const orderId = orderIdOf.get(id) || id;
    try {
      const { trackingNumber } = await refreshTracking(id);
      if (trackingNumber) refreshed.push({ id, orderId, trackingNumber });
      else stillMissing.push({ id, orderId });
    } catch (err) {
      failed.push({ id, orderId, message: err.message });
    }
  }

  console.log(`[fulfillment] Refresh tracking: ${refreshed.length} found, ${stillMissing.length} not issued yet, ${failed.length} failed`);

  return { refreshed, stillMissing, failed };
}

/**
 * Get the 3PL event history for a package (status enum in KB §10.4).
 *
 * @param {string} orderRowId
 * @returns {Promise<{ currentStatus: string|null, events: Array }>}
 */
async function getTrackingEvents(orderRowId) {
  const ctx = await loadContext(orderRowId);

  const resp = await shopeeService.getTrackingInfo(
    ctx.accessToken, ctx.store.shopId, ctx.order.orderId,
    await packageNumberForLogistics(ctx.order));

  return {
    currentStatus: resp.response?.logistics_status || null,
    events: resp.response?.tracking_info || [],
  };
}

// ── Air waybills ──────────────────────────────────────────────────────────────

/**
 * Decide whether an order row is inside the AWB printing window (KB §7.3).
 *
 * @param {Object} order - Local order row
 * @returns {{ ok: boolean, reason?: string }}
 */
/** Order statuses where the parcel is gone or dead — nothing left to label. */
const ORDER_STATUS_TOO_LATE = [
  'SHIPPED',
  'TO_CONFIRM_RECEIVE',
  'COMPLETED',
  'CANCELLED',
  'TO_RETURN',
];

function checkAwbPrintable(order, options = {}) {
  const { shopeeIssued = false } = options;

  if (!order.trackingNumber) {
    return { ok: false, reason: 'no tracking number yet' };
  }

  // Shopee only generates an air waybill while the order is PROCESSED (KB §7.3).
  // Its First Mile guide is blunt about the upper bound: a SHIPPED order "can no
  // longer print airwaybill via openAPI" — only through Seller Centre. Checking
  // here turns a confusing API rejection into a clear message.
  if (shopeeIssued && order.status !== 'PROCESSED') {
    return {
      ok: false,
      reason: `Shopee only issues an air waybill while the order is PROCESSED (this one is ${order.status})`,
    };
  }

  const ls = order.logisticsStatus;

  // Unknown fulfillment state — every row predating that column, and all TikTok
  // orders. Fall back to the order status, which still rules out anything the
  // courier has already taken.
  if (!ls) {
    if (ORDER_STATUS_TOO_LATE.includes(order.status)) {
      return { ok: false, reason: `order is already ${order.status}` };
    }
    return { ok: true };
  }

  if (AWB_TOO_EARLY.has(ls)) return { ok: false, reason: `shipment not arranged yet (${ls})` };
  if (AWB_TOO_LATE.has(ls))  return { ok: false, reason: `printing window closed (${ls})` };
  if (!AWB_PRINTABLE.has(ls)) return { ok: false, reason: `unexpected fulfillment status (${ls})` };

  return { ok: true };
}

/**
 * Fetch the official Shopee AWB for a set of order rows.
 *
 * All rows must belong to the same store, because the document request is
 * authenticated per shop. Rows outside the printing window are rejected up
 * front — `download_shipping_document` fails the entire request if even one
 * package is not READY (KB §7.3), so partial batches are not worth attempting.
 *
 * Shopee additionally refuses to put two couriers in one document
 * ("packages_can_not_download_together … different channel_id"), which made a
 * mixed selection unprintable and forced the operator to filter by courier and
 * print each group by hand. So the selection is grouped by logistics channel,
 * fetched one document per group, and the PDFs are stitched back into the
 * single file the operator asked for.
 *
 * @param {string[]} orderRowIds
 * @param {Object} [options={}]
 * @param {string} [options.shippingDocumentType]
 * @returns {Promise<{ buffer: Buffer, format: string, documentType: string, filePath: string, orderRowIds: string[], channelCount: number }>}
 */
async function fetchAwb(orderRowIds, options = {}) {
  if (!Array.isArray(orderRowIds) || orderRowIds.length === 0) {
    throw fail(400, 'orderRowIds must be a non-empty array');
  }
  if (orderRowIds.length > 50) {
    throw fail(400, 'Shopee accepts at most 50 packages per shipping-document request');
  }

  const rows = await prisma.order.findMany({
    where: { id: { in: orderRowIds } },
    include: { store: true },
  });

  if (rows.length !== orderRowIds.length) {
    throw fail(404, 'Some orders were not found');
  }

  const storeIds = [...new Set(rows.map(r => r.storeId))];
  if (storeIds.length > 1) {
    throw fail(400, 'All packages in one AWB request must belong to the same store');
  }

  const store = rows[0].store;
  if (store.platform !== 'SHOPEE') {
    throw fail(400, `Shopee AWBs are not available for ${store.platform} stores`);
  }

  const blocked = rows
    .map(r => ({ row: r, check: checkAwbPrintable(r, { shopeeIssued: true }) }))
    .filter(x => !x.check.ok);

  if (blocked.length > 0) {
    const detail = blocked.map(b => `${b.row.orderId}: ${b.check.reason}`).join('; ');
    throw fail(409, `${blocked.length} package(s) cannot be printed — ${detail}`);
  }

  const accessToken = await ensureFreshToken(store);

  // Rows whose channel was never recorded are keyed separately rather than
  // lumped with a real channel — an unknown is not evidence of a match, and
  // guessing wrong resurrects the very error this grouping exists to avoid.
  const byChannel = new Map();
  for (const r of rows) {
    const key = r.logisticsChannelId == null ? `unknown:${r.id}` : String(r.logisticsChannelId);
    if (!byChannel.has(key)) byChannel.set(key, []);
    byChannel.get(key).push(r);
  }

  console.log(`[fulfillment] AWB for ${rows.length} package(s) across ${byChannel.size} channel(s)`);

  const docs = [];
  for (const [key, group] of byChannel) {
    const doc = await shopeeService.fetchShippingDocument(
      accessToken,
      store.shopId,
      group.map(r => ({
        orderSn:        r.orderId,
        packageNumber:  r.packageNumber || undefined,
        trackingNumber: r.trackingNumber || undefined,
      })),
      { shippingDocumentType: options.shippingDocumentType },
    );
    console.log(`[fulfillment] AWB channel ${key}: ${group.length} package(s) → ${doc.format}`);
    docs.push(doc);
  }

  const doc = docs.length === 1 ? docs[0] : await mergeAwbDocuments(docs);

  fs.mkdirSync(AWB_DIR, { recursive: true });
  const fileName = `awb-${Date.now()}-${rows.length}pkg.${doc.format === 'unknown' ? 'bin' : doc.format}`;
  const filePath = path.join(AWB_DIR, fileName);
  fs.writeFileSync(filePath, doc.buffer);

  await prisma.order.updateMany({
    where: { id: { in: orderRowIds } },
    data: {
      awbPath:         filePath,
      awbFormat:       doc.format,
      awbDocumentType: doc.documentType,
      awbFetchedAt:    new Date(),
    },
  });

  console.log(`[fulfillment] Downloaded Shopee AWB for ${rows.length} package(s) → ${filePath} (${doc.format})`);

  return { ...doc, filePath, orderRowIds, channelCount: byChannel.size };
}

/**
 * Stitch the per-channel documents back into one file.
 *
 * Only PDF can be merged. Shopee also serves HTML (TW) and ZIP (thermal
 * printing) per KB §7.2, and concatenating either produces a file that opens to
 * a fraction of the labels — worse than refusing, because the operator would
 * ship the packages whose labels silently went missing. Those markets keep the
 * old one-courier-at-a-time flow, with an error that says so.
 *
 * @param {Array<{ buffer: Buffer, format: string, documentType: string }>} docs
 * @returns {Promise<{ buffer: Buffer, format: string, documentType: string }>}
 */
async function mergeAwbDocuments(docs) {
  const formats = [...new Set(docs.map(d => d.format))];

  if (formats.length > 1 || formats[0] !== 'pdf') {
    throw fail(
      409,
      `Pesanan terpilih memakai beberapa ekspedisi dan Shopee mengirim formatnya sebagai ${
        formats.join(' + ')} — hanya PDF yang bisa digabung. Cetak per ekspedisi untuk pesanan ini.`,
    );
  }

  const merged = await PDFDocument.create();

  for (const doc of docs) {
    const src = await PDFDocument.load(doc.buffer);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }

  return {
    buffer: Buffer.from(await merged.save()),
    format: 'pdf',
    documentType: docs[0].documentType,
  };
}

/**
 * Read back an AWB already downloaded for an order row.
 *
 * Avoids hitting Shopee again for a reprint, and still works after the package
 * has left the printing window — the file was fetched while it was still valid.
 *
 * @param {string} orderRowId
 * @returns {Promise<{ buffer: Buffer, format: string, filePath: string }>}
 */
async function readStoredAwb(orderRowId) {
  const order = await prisma.order.findUnique({ where: { id: orderRowId } });
  if (!order) throw fail(404, 'Order not found');

  if (!order.awbPath) {
    throw fail(404, 'No Shopee air waybill has been downloaded for this order yet');
  }
  if (!fs.existsSync(order.awbPath)) {
    throw fail(410, 'The stored air waybill file is no longer on disk — download it again from Shopee');
  }

  return {
    buffer: fs.readFileSync(order.awbPath),
    format: order.awbFormat || 'unknown',
    filePath: order.awbPath,
  };
}

/**
 * Delete AWB files older than the retention window.
 *
 * Air waybills are only useful until the parcel is collected, but the files
 * accumulate indefinitely otherwise. Rows pointing at a removed file keep their
 * `awbFetchedAt` for audit while `awbPath` is cleared.
 *
 * @param {number} [retentionDays=30]
 * @returns {Promise<{ deleted: number, freedBytes: number }>}
 */
async function cleanupOldAwbFiles(retentionDays = 30) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const stale = await prisma.order.findMany({
    where: { awbPath: { not: null }, awbFetchedAt: { lt: cutoff } },
    select: { id: true, awbPath: true },
  });

  if (stale.length === 0) return { deleted: 0, freedBytes: 0 };

  let deleted = 0;
  let freedBytes = 0;

  // Several rows share one file when the AWB covered a batch
  const paths = [...new Set(stale.map(r => r.awbPath))];
  for (const filePath of paths) {
    try {
      if (fs.existsSync(filePath)) {
        freedBytes += fs.statSync(filePath).size;
        fs.unlinkSync(filePath);
      }
      deleted++;
    } catch (err) {
      console.warn(`[fulfillment] Could not delete stale AWB ${filePath}: ${err.message}`);
    }
  }

  await prisma.order.updateMany({
    where: { id: { in: stale.map(r => r.id) } },
    data: { awbPath: null },
  });

  console.log(`[fulfillment] AWB cleanup: removed ${deleted} file(s), freed ${(freedBytes / 1024).toFixed(0)} KB, cleared ${stale.length} row reference(s)`);
  return { deleted, freedBytes };
}

/**
 * Fetch the raw AWB field data used to render a self-designed label (KB §5 7a).
 *
 * @param {string[]} orderRowIds
 * @returns {Promise<Object>}
 */
async function fetchAwbDataInfo(orderRowIds) {
  if (!Array.isArray(orderRowIds) || orderRowIds.length === 0) {
    throw fail(400, 'orderRowIds must be a non-empty array');
  }

  const rows = await prisma.order.findMany({
    where: { id: { in: orderRowIds } },
    include: { store: true },
  });

  if (rows.length === 0) throw fail(404, 'No orders found');

  const storeIds = [...new Set(rows.map(r => r.storeId))];
  if (storeIds.length > 1) {
    throw fail(400, 'All packages in one request must belong to the same store');
  }

  const store = rows[0].store;
  if (store.platform !== 'SHOPEE') {
    throw fail(400, `Not available for ${store.platform} stores`);
  }

  const accessToken = await ensureFreshToken(store);

  const resp = await shopeeService.getShippingDocumentDataInfo(
    accessToken,
    store.shopId,
    rows.map(r => ({ orderSn: r.orderId, packageNumber: r.packageNumber || undefined })),
  );

  return resp.response || {};
}

/**
 * Best-effort lookup of official AWB field data for a set of order rows.
 *
 * Used to enrich self-printed labels with the courier routing information that
 * only Shopee holds (KB §5 step 7a). Deliberately never throws: a label without
 * a sort code is still printable, so a failure here must not abort a print run.
 *
 * @param {Object[]} rows - Order rows including their store
 * @returns {Promise<Map<string, Object>>} Keyed by `${orderId}::${packageNumber}`
 */
async function fetchAwbDataForRows(rows) {
  const map = new Map();

  const shopeeRows = rows.filter(r => r.store?.platform === 'SHOPEE' && r.trackingNumber);
  if (shopeeRows.length === 0) return map;

  // One request per shop, batched to Shopee's 50-package limit
  const byStore = new Map();
  for (const row of shopeeRows) {
    if (!byStore.has(row.storeId)) byStore.set(row.storeId, []);
    byStore.get(row.storeId).push(row);
  }

  for (const storeRows of byStore.values()) {
    const store = storeRows[0].store;

    let accessToken;
    try {
      accessToken = await ensureFreshToken(store);
    } catch (err) {
      console.warn(`[fulfillment] Skipping AWB data for store ${store.id}: ${err.message}`);
      continue;
    }

    for (let i = 0; i < storeRows.length; i += 50) {
      const chunk = storeRows.slice(i, i + 50);
      try {
        const resp = await shopeeService.getShippingDocumentDataInfo(
          accessToken,
          store.shopId,
          chunk.map(r => ({ orderSn: r.orderId, packageNumber: r.packageNumber || undefined })),
        );

        const results = resp.response?.data_info_list || resp.response?.result_list || [];
        for (const entry of results) {
          const key = `${entry.order_sn}::${entry.package_number || ''}`;
          map.set(key, entry);
        }
      } catch (err) {
        console.warn(`[fulfillment] AWB data lookup failed for ${chunk.length} package(s): ${err.message}`);
      }
    }
  }

  console.log(`[fulfillment] Resolved official AWB data for ${map.size}/${shopeeRows.length} package(s)`);
  return map;
}

module.exports = {
  fetchAwbDataForRows,
  getShippingOptions,
  groupRowsForShipping,
  getMassShippingOptions,
  arrangeShipment,
  massArrangeShipment,
  retryShipment,
  getSplitOptions,
  splitOrder,
  unsplitOrder,
  validateSplit,
  cancelOrder,
  respondToCancellation,
  refreshTracking,
  refreshTrackingMany,
  getTrackingEvents,
  checkAwbPrintable,
  fetchAwb,
  mergeAwbDocuments,
  readStoredAwb,
  cleanupOldAwbFiles,
  fetchAwbDataInfo,
  AWB_PRINTABLE,
  AWB_TOO_EARLY,
  AWB_TOO_LATE,
};
