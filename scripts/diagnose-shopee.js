#!/usr/bin/env node
'use strict';

/**
 * diagnose-shopee.js — read-only probe of what Shopee actually returns.
 *
 * Much of the Shopee integration was written against a knowledge base that
 * documents endpoint *semantics* but not every response *shape*. Where the
 * shape had to be inferred, a wrong guess fails quietly: a field simply never
 * arrives and a column stays null. This script prints the real structures so
 * those guesses can be confirmed or corrected against live data.
 *
 * It performs no writes — no ship, no cancel, no print, no database updates.
 *
 * Usage, from inside the running container:
 *
 *   node scripts/diagnose-shopee.js                # first healthy Shopee store
 *   node scripts/diagnose-shopee.js <storeId>      # a specific store
 */

const prisma = require('../src/prisma/client.js');
const shopeeService = require('../src/services/shopee.js');
const { ensureFreshToken } = require('../src/services/tokens.js');

/** Describe a value's structure without dumping personal data. */
function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return value.length === 0 ? '[] (empty)' : `[${value.length} × ${shapeOf(value[0], depth + 1)}]`;
  }
  if (typeof value === 'object') {
    if (depth > 1) return '{…}';
    return `{ ${Object.keys(value).join(', ')} }`;
  }
  return typeof value;
}

function heading(text) {
  console.log(`\n${'─'.repeat(70)}\n${text}\n${'─'.repeat(70)}`);
}

async function main() {
  const storeIdArg = process.argv[2];

  const store = storeIdArg
    ? await prisma.store.findUnique({ where: { id: storeIdArg } })
    : await prisma.store.findFirst({
      where: { platform: 'SHOPEE', isActive: true, needsReconnect: false },
    });

  if (!store) {
    console.error('No usable Shopee store found. Reconnect a store first, or pass a store id.');
    process.exit(1);
  }

  console.log(`Store : ${store.name} (${store.id})`);
  console.log(`Shop  : ${store.shopId}`);
  console.log(`Token : expires ${store.tokenExpiry?.toISOString() || 'unknown'}`);

  const accessToken = await ensureFreshToken(store);

  // ── 1. Which packages does search_package_list return? ──────────────────────
  heading('1. search_package_list (KB Rule #4 — source of package_number)');
  try {
    const resp = await shopeeService.searchPackageList(accessToken, store.shopId, { packageStatus: 0, pageSize: 5 });
    console.log('response keys :', Object.keys(resp.response || {}).join(', ') || '(none)');
    console.log('package_list  :', shapeOf(resp.response?.package_list));
    const first = resp.response?.package_list?.[0];
    if (first) console.log('first entry   :', JSON.stringify(first, null, 2));
  } catch (err) {
    console.error('FAILED:', err.message);
  }

  // ── 2. What does get_order_detail actually contain? ──────────────────────────
  heading('2. get_order_detail — tracking_number and package_list');

  const localOrders = await prisma.order.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { orderId: true, packageNumber: true, status: true, trackingNumber: true },
  });

  if (localOrders.length === 0) {
    console.log('No local orders for this store yet — run a sync first.');
  } else {
    console.log('Local rows:');
    for (const o of localOrders) {
      console.log(`  ${o.orderId} pkg="${o.packageNumber}" status=${o.status} tracking=${o.trackingNumber || 'NULL'}`);
    }

    const orderSns = [...new Set(localOrders.map(o => o.orderId))];
    try {
      const resp = await shopeeService.getOrderDetail(accessToken, store.shopId, orderSns);
      const list = resp.response?.order_list || [];
      console.log(`\nShopee returned ${list.length} order(s):`);

      for (const detail of list) {
        console.log(`\n  ${detail.order_sn}`);
        console.log(`    order_status          : ${detail.order_status}`);
        console.log(`    tracking_number       : ${detail.tracking_number ? `"${detail.tracking_number}"` : 'MISSING'}`);
        console.log(`    package_list          : ${shapeOf(detail.package_list)}`);

        for (const pkg of detail.package_list || []) {
          console.log(`      package_number      : ${pkg.package_number || '(empty)'}`);
          console.log(`      logistics_status    : ${pkg.logistics_status || 'MISSING'}`);
          console.log(`      logistics_channel_id: ${pkg.logistics_channel_id ?? 'MISSING'}`);
          console.log(`      keys                : ${Object.keys(pkg).join(', ')}`);
        }
      }
    } catch (err) {
      console.error('FAILED:', err.message);
    }
  }

  // ── 3. The response shape this app most likely gets wrong ───────────────────
  heading('3. get_tracking_number / get_mass_tracking_number');

  const missing = localOrders.filter(o => !o.trackingNumber);
  const probe = missing[0] || localOrders[0];

  if (!probe) {
    console.log('No order available to probe.');
  } else {
    console.log(`Probing ${probe.orderId} (pkg "${probe.packageNumber}")\n`);

    try {
      const single = await shopeeService.getTrackingNumber(
        accessToken, store.shopId, probe.orderId, probe.packageNumber || undefined);
      console.log('single → response keys :', Object.keys(single.response || {}).join(', ') || '(none)');
      console.log('single → tracking_number:', single.response?.tracking_number || 'MISSING');
    } catch (err) {
      console.error('single FAILED:', err.message);
    }

    try {
      const mass = await shopeeService.getMassTrackingNumber(accessToken, store.shopId,
        [{ order_sn: probe.orderId, package_number: probe.packageNumber || undefined }]);
      console.log('\nmass   → response keys :', Object.keys(mass.response || {}).join(', ') || '(none)');
      for (const [key, value] of Object.entries(mass.response || {})) {
        console.log(`         ${key}: ${shapeOf(value)}`);
      }
      console.log('\nRAW (this is the shape syncDirect must read):');
      console.log(JSON.stringify(mass.response, null, 2));
    } catch (err) {
      console.error('mass FAILED:', err.message);
    }
  }

  // ── 4. AWB parameter shape — the least verified area of all ─────────────────
  heading('4. get_shipping_document_parameter (AWB path, unverified)');

  const printable = localOrders.find(o => o.trackingNumber);
  if (!printable) {
    console.log('Skipped — needs an order that already has a tracking number.');
  } else {
    try {
      const resp = await shopeeService.getShippingDocumentParameter(accessToken, store.shopId,
        [{ orderSn: printable.orderId, packageNumber: printable.packageNumber || undefined }]);
      console.log('response keys :', Object.keys(resp.response || {}).join(', ') || '(none)');
      console.log(JSON.stringify(resp.response, null, 2));
    } catch (err) {
      console.error('FAILED:', err.message);
      console.error('→ If this says the request is malformed, the order_list shape in');
      console.error('  shopee.js needs correcting. This was inferred, not documented.');
    }
  }

  heading('Done — no data was modified');
}

main()
  .catch((err) => {
    console.error('\nDiagnostic aborted:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
