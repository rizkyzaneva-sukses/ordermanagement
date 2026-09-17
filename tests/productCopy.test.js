'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  snapshotToPayload, validatePayload, normaliseLimits, imagesToUpload,
  buildAddItemBody, buildTierVariationBody, planListingBinding, explainShopeeError,
} = require('../src/services/productCopy.js');

// Shaped after the item the probe read on 17 Sep 2026 (Zaneva Official Shop):
// extended description, variations, per-model weight echoing the item's.
const item = {
  item_id: 44270717785,
  category_id: 100637,
  item_name: 'Zaneva - Zora Cap Topi Hijab Sport Wanita Running',
  item_sku: 'ZORA',
  description_type: 'extended',
  description_info: {
    extended_description: {
      field_list: [
        { field_type: 'text', text: 'ZANEVA - Zora Cap Sport Hijab Friendly. Topi sport muslimah bahan dusky crinkle premium.' },
        { field_type: 'image', image_info: { image_id: 'src-desc-1', image_url: 'https://cf.shopee.co.id/file/desc1' } },
      ],
    },
  },
  image: {
    image_id_list: ['src-1', 'src-2', 'src-3'],
    image_url_list: ['https://cf.shopee.co.id/file/1', 'https://cf.shopee.co.id/file/2', 'https://cf.shopee.co.id/file/3'],
  },
  attribute_list: [
    { attribute_id: 100010, original_attribute_name: 'Jenis Kelamin', is_mandatory: true,
      attribute_value_list: [{ value_id: 2, original_value_name: 'Unisex', value_unit: '' }] },
  ],
  brand: { brand_id: 1234, original_brand_name: 'Zaneva' },
  weight: '0.06',
  dimension: { package_length: 20, package_width: 15, package_height: 5 },
  logistic_info: [
    { logistic_id: 8003, logistic_name: 'Reguler', enabled: true },
    { logistic_id: 8005, logistic_name: 'Hemat Kargo', enabled: false },
    { logistic_id: 8007, logistic_name: 'Instant', enabled: true },
  ],
  pre_order: { is_pre_order: false, days_to_ship: 2 },
  condition: 'NEW',
  has_model: true,
  size_chart: '',
  size_chart_id: 0,
  item_dangerous: 0,
};

const models = {
  tier_variation: [{
    name: 'Warna',
    option_list: [
      { option: 'Red', image: { image_id: 'src-red', image_url: 'https://cf.shopee.co.id/file/red' } },
      { option: 'Black', image: { image_id: 'src-black', image_url: 'https://cf.shopee.co.id/file/black' } },
    ],
  }],
  model: [
    { model_id: 501, tier_index: [0], model_sku: 'Zora Cap - Red', weight: '0.06',
      dimension: { package_length: 0, package_width: 0, package_height: 0 },
      price_info: [{ current_price: 99000, original_price: 122000 }],
      stock_info_v2: { seller_stock: [{ stock: 971 }], summary_info: { total_available_stock: 960 } } },
    { model_id: 502, tier_index: [1], model_sku: 'Zora Cap - Black', weight: '0.06',
      dimension: { package_length: 0, package_width: 0, package_height: 0 },
      price_info: [{ current_price: 122000, original_price: 122000 }],
      stock_info_v2: { seller_stock: [{ stock: 979 }] } },
  ],
};

const limits = normaliseLimits({
  item_name_length_limit: { min_limit: 10, max_limit: 255 },
  item_image_count_limit: { min_limit: 3, max_limit: 9 },
  size_chart_limit: { size_chart_mandatory: false },
});

/** Every source image "uploaded", keyed the way Publish stores them. */
function uploadedFor(payload) {
  return Object.fromEntries(imagesToUpload(payload).map((img, i) => [img.ref, `new-${i}`]));
}

const renamed = (payload) => ({ ...payload, name: `${payload.name} Curve` });

test('copy starts from the pre-promotion price and the stock the seller set', () => {
  const p = snapshotToPayload({ item, models });
  const red = p.models.find(m => m.sourceModelId === '501');
  // 99000 is a promo price in the source shop; 960 excludes its unpaid orders.
  assert.equal(red.price, 122000);
  assert.equal(red.stock, 971);
});

test('extended description keeps its blocks in order, images included', () => {
  const p = snapshotToPayload({ item, models });
  assert.equal(p.descriptionType, 'extended');
  assert.deepEqual(p.descriptionBlocks.map(b => b.type), ['text', 'image']);
  assert.equal(p.descriptionBlocks[1].url, 'https://cf.shopee.co.id/file/desc1');
});

test('weight comes over in grams, and an echoed model weight is not per-variation shipping', () => {
  const p = snapshotToPayload({ item, models });
  assert.equal(p.weightGram, 60);
  assert.deepEqual(p.dimension, { length: 20, width: 15, height: 5 });
  assert.equal(p.perModelShipping, false);
});

test('a template size chart from the source is flagged, not silently reused', () => {
  const p = snapshotToPayload({ item: { ...item, size_chart_id: 777 }, models });
  assert.deepEqual(p.sizeChart, { kind: 'template', templateId: 777, fromSource: true });

  const errors = validatePayload(renamed(p), {
    limits: { ...limits, sizeChartMandatory: true }, sourceName: item.item_name,
  });
  assert.ok(errors.some(e => e.field === 'sizeChart' && /template toko asal/.test(e.message)));
});

test('an unchanged name blocks Publish; a renamed one passes', () => {
  const p = snapshotToPayload({ item, models });
  const same = validatePayload(p, { limits, sourceName: item.item_name });
  assert.ok(same.some(e => e.field === 'name'));

  const ok = validatePayload(renamed(p), { limits, sourceName: item.item_name });
  assert.deepEqual(ok, []);
});

test('fewer than three photos is caught before Shopee rejects it', () => {
  const p = renamed(snapshotToPayload({ item, models }));
  p.images = p.images.slice(0, 2);
  const errors = validatePayload(p, { limits, sourceName: item.item_name });
  assert.ok(errors.some(e => e.field === 'images'));
});

test('a variation list that no longer covers every option is caught', () => {
  const p = renamed(snapshotToPayload({ item, models }));
  p.tiers[0].options.push({ key: 'new1', name: 'White', sourceName: null, image: { imageId: 'up-white' } });
  const errors = validatePayload(p, { limits, sourceName: item.item_name });
  assert.ok(errors.some(e => e.field === 'models'));
});

test('a channel that is off in the destination shop, or too light for the product, is caught', () => {
  const p = renamed(snapshotToPayload({ item, models }));
  p.weightGram = 4000;
  const channels = new Map([
    [8003, { enabled: true, maxWeightKg: 0, name: 'Reguler (Cashless)' }],
    [8007, { enabled: false, maxWeightKg: 0, name: 'Instant' }],
    [80055, { enabled: true, maxWeightKg: 3, name: 'SPX Ambil di Tempat' }],
  ]);
  p.logistics.push({ channelId: 80055, name: 'SPX Ambil di Tempat', enabled: true });
  const errors = validatePayload(p, { limits, sourceName: item.item_name, channels });
  assert.ok(errors.some(e => /Instant.*tidak aktif/.test(e.message)));
  assert.ok(errors.some(e => /SPX Ambil di Tempat.*3\.000 g/.test(e.message)));
});

test('images are uploaded once each, with description images kept unsquared', () => {
  const p = snapshotToPayload({ item, models });
  p.images.push({ ...p.images[0] }); // same photo twice on the form
  const uploads = imagesToUpload(p);
  assert.equal(uploads.filter(u => u.url === 'https://cf.shopee.co.id/file/1').length, 1);
  assert.equal(uploads.find(u => u.url === 'https://cf.shopee.co.id/file/desc1').scene, 'desc');
  assert.equal(uploads.find(u => u.url === 'https://cf.shopee.co.id/file/red').scene, 'normal');
});

test('add_item body: created unlisted, weight in kg, only chosen channels, uploaded image ids', () => {
  const p = renamed(snapshotToPayload({ item, models }));
  const body = buildAddItemBody(p, uploadedFor(p));

  assert.equal(body.item_status, 'UNLIST');
  assert.equal(body.weight, 0.06);
  assert.deepEqual(body.logistic_info.map(l => l.logistic_id), [8003, 8007]);
  assert.equal(body.image.image_id_list.length, 3);
  assert.ok(body.image.image_id_list.every(id => id.startsWith('new-')), 'source shop image ids must not be sent');
  assert.equal(body.description_type, 'extended');
  assert.equal(body.description_info.extended_description.field_list[1].image_info.image_id.startsWith('new-'), true);
  assert.equal(body.description, undefined);
  assert.equal(body.original_price, 122000);
  assert.equal(body.seller_stock[0].stock, 971 + 979);
});

test('add_item refuses to build with a photo that never uploaded, and says which', () => {
  const p = renamed(snapshotToPayload({ item, models }));
  assert.throws(() => buildAddItemBody(p, {}), /Foto 1 belum terunggah/);
});

test('tier body follows the form order after options are reordered and renamed', () => {
  const p = renamed(snapshotToPayload({ item, models }));
  p.tiers[0].options.reverse();                 // Black first now
  p.tiers[0].options[1].name = 'Merah';         // Red renamed
  const body = buildTierVariationBody(p, 900001, uploadedFor(p));

  assert.deepEqual(body.tier_variation[0].option_list.map(o => o.option), ['Black', 'Merah']);
  const red = body.model.find(m => m.model_sku === 'Zora Cap - Red');
  assert.deepEqual(red.tier_index, [1]);
  assert.equal(red.weight, undefined, 'no per-model weight unless the toggle is on');
});

test('new variations inherit the master of the source variation they were copied from', () => {
  const p = renamed(snapshotToPayload({ item, models }));
  p.tiers[0].options.reverse();
  p.tiers[0].options[1].name = 'Merah';
  p.tiers[0].options.push({ key: 'added', name: 'White', sourceName: null, image: { imageId: 'up-white' } });
  p.models.push({ optionKeys: ['added'], sourceModelId: null, price: 122000, stock: 10, sku: '' });

  const sourceListings = [
    { modelId: '501', productId: 'master-red' },
    { modelId: '502', productId: 'master-black' },
  ];
  // Shopee's new model ids, by position in the order the form sent
  const newModels = [
    { model_id: 9001, tier_index: [0] }, // Black
    { model_id: 9002, tier_index: [1] }, // Merah (was Red)
    { model_id: 9003, tier_index: [2] }, // White, added on the form
  ];

  assert.deepEqual(planListingBinding(p, newModels, sourceListings), [
    { modelId: '9001', productId: 'master-black' },
    { modelId: '9002', productId: 'master-red' },
  ]);
});

test('an item without variations binds its single listing', () => {
  const plain = { ...item, has_model: false, price_info: [{ original_price: 50000 }], stock_info_v2: { seller_stock: [{ stock: 5 }] } };
  const p = snapshotToPayload({ item: plain });
  assert.equal(p.tiers.length, 0);
  assert.equal(p.price, 50000);
  assert.deepEqual(planListingBinding(p, [], [{ modelId: '', productId: 'm1' }]), [{ modelId: '', productId: 'm1' }]);
});

test('Shopee errors are explained, and unknown ones are quoted rather than hidden', () => {
  const known = explainShopeeError({ shopeeError: 'product.error_param', shopeeMessage: 'invalid logistic channel 8007' });
  assert.match(known, /Jasa kirim ditolak Shopee/);
  assert.match(known, /invalid logistic channel 8007/);

  const unknown = explainShopeeError({ shopeeError: 'product.error_busi', shopeeMessage: 'something new' });
  assert.equal(unknown, 'product.error_busi: something new');
});
