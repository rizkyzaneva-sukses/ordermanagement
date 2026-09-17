#!/usr/bin/env node
'use strict';

/**
 * probe-product-write.js — may this app create products on Shopee?
 *
 * "Salin Produk" (copy a listing from one shop to another) ends in
 * `add_item`, and needs `media_space/upload_image`, `get_attribute_tree`,
 * `get_brand_list` and the logistics channel list on the way. The catalogue
 * pull already proves the Product *read* endpoints work. Nothing yet proves the
 * write side does, and a feature built on an endpoint the partner app may not
 * call is weeks of work that cannot run — the same trap probe-chat.js was
 * written to avoid.
 *
 * WRITE ENDPOINTS ARE CALLED WITH EMPTY BODIES, so nothing can be created or
 * changed: Shopee checks the caller's permission before it validates the body,
 * so an empty `add_item` answers either "no permission" (the app cannot) or a
 * parameter error (the app can, the body is just missing). Which of the two
 * comes back is the whole result. Nothing is written to the database either.
 *
 * It also prints which fields `get_item_base_info` actually returns for one
 * real item — description, attributes, weight, logistics — because a copy can
 * only carry over what the source call hands back.
 *
 * Usage, from inside the running container:
 *
 *   node scripts/probe-product-write.js              # first healthy Shopee store
 *   node scripts/probe-product-write.js <storeId>    # a specific store
 */

const prisma = require('../src/prisma/client.js');
const shopeeService = require('../src/services/shopee.js');
const { ensureFreshToken } = require('../src/services/tokens.js');

function heading(text) {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`);
}

/**
 * One raw call. Bypasses ShopeeService._request on purpose: that retries and
 * throws on any `error` field, and here the error field is the evidence.
 *
 * `scope: 'public'` signs without token and shop id, which is how Shopee
 * documents media_space upload; the same path is also tried shop-signed in case
 * this partner account is set up the other way.
 */
async function call({ method = 'GET', path, params = {}, body, scope = 'shop' }, store, accessToken) {
  const url = scope === 'public'
    ? shopeeService._buildUrl(path, params)
    : shopeeService._buildUrl(path, params, accessToken, String(store.shopId));

  const options = { method, headers: {} };
  if (method === 'POST') {
    if (body instanceof FormData) {
      options.body = body;
    } else {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body ?? {});
    }
  }

  try {
    const res = await fetch(url, options);
    const raw = await res.text();
    try {
      return { http: res.status, body: JSON.parse(raw) };
    } catch {
      return { http: res.status, body: null, raw: raw.slice(0, 200) };
    }
  } catch (err) {
    return { http: 0, body: null, raw: `network: ${err.message}` };
  }
}

/** permission | param | ok | unknown — how a write probe answered. */
function classify(result) {
  const err = String(result.body?.error || '');
  const msg = String(result.body?.message || '');
  if (!result.body) return 'unknown';
  if (!err) return 'ok';
  if (/permission|auth|scope|access_denied|no_access|forbidden/i.test(`${err} ${msg}`)) return 'permission';
  if (/param|invalid|required|empty|missing|illegal/i.test(`${err} ${msg}`)) return 'param';
  return 'unknown';
}

function report(label, result) {
  console.log(label);
  console.log(`  HTTP    : ${result.http}`);
  console.log(`  error   : ${result.body?.error || '(none)'}`);
  console.log(`  message : ${result.body?.message || result.raw || '(none)'}`);
  if (result.body?.response) {
    console.log(`  keys    : ${Object.keys(result.body.response).join(', ') || '(empty)'}`);
  }
}

async function main() {
  const storeId = process.argv[2];

  const store = storeId
    ? await prisma.store.findUnique({ where: { id: storeId } })
    : await prisma.store.findFirst({
      where: { platform: 'SHOPEE', isActive: true, needsReconnect: false },
      orderBy: { lastSyncAt: 'desc' },
    });

  if (!store) {
    console.error('No usable Shopee store found. Connect one first, or pass a storeId.');
    process.exitCode = 1;
    return;
  }

  heading(`Probing product write access for "${store.name}" (shop_id ${store.shopId})`);
  console.log('Write endpoints get EMPTY bodies — nothing is created, changed or saved.\n');

  const accessToken = await ensureFreshToken(store);

  // ── 1. Write permission ─────────────────────────────────────────────────────
  heading('1. Write endpoints (empty body)');

  const writes = [
    { label: 'product/add_item', path: '/api/v2/product/add_item', method: 'POST', body: {} },
    { label: 'product/init_tier_variation', path: '/api/v2/product/init_tier_variation', method: 'POST', body: {} },
    { label: 'product/update_stock', path: '/api/v2/product/update_stock', method: 'POST', body: {} },
    { label: 'media_space/upload_image (public sign)', path: '/api/v2/media_space/upload_image', method: 'POST', body: new FormData(), scope: 'public' },
    { label: 'media_space/upload_image (shop sign)', path: '/api/v2/media_space/upload_image', method: 'POST', body: new FormData() },
  ];

  const verdicts = {};
  for (const w of writes) {
    const result = await call(w, store, accessToken);
    report(w.label, result);
    verdicts[w.label] = classify(result);
    console.log(`  verdict : ${verdicts[w.label]}\n`);
  }

  // ── 2. What a copy can carry over ───────────────────────────────────────────
  heading('2. Source item — fields get_item_base_info returns');

  // A product with variations shows more of what a copy has to carry over, so
  // one is preferred; a shop that has none still gets probed with what it has.
  const pick = (extra) => prisma.productListing.findFirst({
    where: { storeId: store.id, status: 'NORMAL', ...extra },
    orderBy: { lastSyncedAt: 'desc' },
    select: { itemId: true, itemName: true, name: true },
  });
  const listing = (await pick({ modelId: { not: '' } })) ?? (await pick({}));

  let categoryId = null;
  if (!listing) {
    console.log('No NORMAL listing in this store — pull the catalogue first. Skipping 2 and 3.');
  } else {
    const info = await call({
      path: '/api/v2/product/get_item_base_info',
      params: { item_id_list: listing.itemId, need_tax_info: false, need_complaint_policy: false },
    }, store, accessToken);
    const item = info.body?.response?.item_list?.[0];
    if (!item) {
      report(`get_item_base_info item ${listing.itemId}`, info);
    } else {
      categoryId = item.category_id;
      console.log(`Item ${listing.itemId}: ${listing.itemName || listing.name}\n`);
      const present = (v) => (v === undefined || v === null || (Array.isArray(v) && v.length === 0) ? 'ABSENT' : 'yes');
      const fields = {
        category_id: item.category_id,
        description: item.description,
        description_type: item.description_type,
        description_info: item.description_info,
        'image.image_id_list': item.image?.image_id_list,
        'image.image_url_list': item.image?.image_url_list,
        attribute_list: item.attribute_list,
        brand: item.brand,
        weight: item.weight,
        dimension: item.dimension,
        logistic_info: item.logistic_info,
        pre_order: item.pre_order,
        condition: item.condition,
        has_model: item.has_model,
        video_info: item.video_info,
        size_chart: item.size_chart ?? item.size_chart_info,
      };
      for (const [k, v] of Object.entries(fields)) {
        console.log(`  ${k.padEnd(22)} ${present(v)}`);
      }
      console.log(`\n  all keys: ${Object.keys(item).join(', ')}`);
      console.log(`  description_type: ${item.description_type ?? '(absent)'}`);
      console.log(`  logistic_info: ${JSON.stringify(item.logistic_info ?? null)}`);

      // Whether a variation can carry its own weight and size decides if the
      // "Berbeda tiap varian" toggle on the edit form is buildable at all.
      if (item.has_model) {
        const models = await call({
          path: '/api/v2/product/get_model_list',
          params: { item_id: listing.itemId },
        }, store, accessToken);
        const model = models.body?.response?.model?.[0];
        if (model) {
          console.log(`\n  model[0] keys: ${Object.keys(model).join(', ')}`);
          console.log(`  model[0] weight: ${JSON.stringify(model.weight ?? null)}  dimension: ${JSON.stringify(model.dimension ?? null)}`);
          const tier = models.body.response.tier_variation?.[0];
          console.log(`  tier_variation[0] keys: ${tier ? Object.keys(tier).join(', ') : '(none)'}`);
          const opt = tier?.option_list?.[0];
          console.log(`  option_list[0] keys: ${opt ? Object.keys(opt).join(', ') : '(none)'}`);
        } else {
          report('get_model_list', models);
        }
      }
    }
  }

  // ── 3. Lookups the edit form needs ──────────────────────────────────────────
  heading('3. Lookup endpoints the edit form would use');

  // Printed in full rather than as keys: how Shopee groups "Reguler (Cashless)"
  // over the couriers inside it decides the shape of the Jasa Kirim list, and
  // which of the two ids add_item expects.
  const channels = await call({ path: '/api/v2/logistics/get_channel_list' }, store, accessToken);
  report('logistics/get_channel_list', channels);
  for (const c of channels.body?.response?.logistics_channel_list ?? []) {
    console.log(`    ${String(c.logistics_channel_id).padEnd(8)} ${c.enabled ? 'ON ' : 'off'} mask=${c.mask_channel_id ?? '-'} `
      + `weight_limit=${JSON.stringify(c.weight_limit ?? null)} ${c.logistics_channel_name}`);
  }
  console.log('');

  const lookups = [
    { label: 'product/get_item_limit', path: '/api/v2/product/get_item_limit', params: categoryId ? { category_id: categoryId } : {} },
  ];
  if (categoryId) {
    lookups.push(
      { label: 'product/get_attribute_tree', path: '/api/v2/product/get_attribute_tree', params: { category_id_list: String(categoryId), language: 'id' } },
      { label: 'product/get_attributes (older name)', path: '/api/v2/product/get_attributes', params: { category_id: categoryId, language: 'id' } },
      { label: 'product/get_brand_list', path: '/api/v2/product/get_brand_list', params: { category_id: categoryId, status: 1, offset: 0, page_size: 5, language: 'id' } },
      { label: 'product/support_size_chart', path: '/api/v2/product/support_size_chart', params: { category_id: categoryId } },
    );
  }

  for (const l of lookups) {
    const result = await call(l, store, accessToken);
    report(l.label, result);
    // Small answers that are the result themselves, not just evidence of access
    if (/get_item_limit|support_size_chart/.test(l.label) && result.body?.response) {
      console.log(`  response: ${JSON.stringify(result.body.response)}`);
    }
    console.log('');
  }

  // ── Verdict ─────────────────────────────────────────────────────────────────
  heading('How to read this');

  const addItem = verdicts['product/add_item'];
  const upload = [verdicts['media_space/upload_image (public sign)'], verdicts['media_space/upload_image (shop sign)']];

  if (addItem === 'param') {
    console.log('add_item: ALLOWED — Shopee complained about the empty body, not about access.');
  } else if (addItem === 'permission') {
    console.log('add_item: NOT ALLOWED — the Product write permission has to be requested');
    console.log('in Shopee Open Platform, then every shop re-authorized.');
  } else {
    console.log(`add_item: inconclusive (${addItem}) — send the raw output above.`);
  }

  if (upload.includes('param')) {
    console.log('upload_image: ALLOWED.');
  } else if (upload.includes('permission')) {
    console.log('upload_image: NOT ALLOWED — the Media Space permission is missing.');
  } else {
    console.log(`upload_image: inconclusive (${upload.join(' / ')}) — send the raw output above.`);
  }

  heading('Done — nothing was created, nothing was modified');
}

main()
  .catch((err) => {
    console.error('\nProbe aborted:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
