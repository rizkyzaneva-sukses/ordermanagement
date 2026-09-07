'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPEE_PARTNER_ID = process.env.SHOPEE_PARTNER_ID || '1';
process.env.SHOPEE_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || 'test-key';

const { buildListingRows, readPrice, readStock } = require('../src/services/productSync.js');

const item = (over = {}) => ({
  item_id: 111,
  item_name: 'Zaneva Curve — Sidney Vest Outer',
  item_sku: 'Y-Sidney',
  item_status: 'NORMAL',
  has_model: false,
  image: { image_url_list: ['https://cf.shopee/a.jpg', 'https://cf.shopee/b.jpg'] },
  price_info: [{ current_price: 150000, original_price: 199000 }],
  stock_info_v2: { summary_info: { total_available_stock: 7 } },
  ...over,
});

test('an item without variations becomes exactly one row', () => {
  const rows = buildListingRows(item(), []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].itemId, '111');
  assert.equal(rows[0].modelId, '');
  assert.equal(rows[0].sku, 'Y-Sidney');
  assert.equal(rows[0].price, 150000);
  assert.equal(rows[0].stock, 7);
  assert.equal(rows[0].imageUrl, 'https://cf.shopee/a.jpg');
});

test('an item with variations contributes its models and not itself', () => {
  // Storing both would double every multi-variant listing and make the stock
  // totals meaningless — the whole reason models are fetched at all.
  const models = [
    { model_id: 1, model_sku: 'Y-Sidney-M', model_name: 'M / Navy',
      price_info: [{ current_price: 150000 }],
      stock_info_v2: { summary_info: { total_available_stock: 3 } } },
    { model_id: 2, model_sku: 'Y-Sidney-L', model_name: 'L / Navy',
      price_info: [{ current_price: 155000 }],
      stock_info_v2: { summary_info: { total_available_stock: 4 } } },
  ];

  const rows = buildListingRows(item({ has_model: true }), models);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.modelId), ['1', '2']);
  assert.deepEqual(rows.map(r => r.sku), ['Y-Sidney-M', 'Y-Sidney-L']);
  assert.deepEqual(rows.map(r => r.stock), [3, 4]);
  // Every row still points at the same Shopee item
  assert.deepEqual([...new Set(rows.map(r => r.itemId))], ['111']);
});

test('a variation is named so it can be told apart in a list of 1300', () => {
  const rows = buildListingRows(item({ has_model: true }), [
    { model_id: 9, model_name: 'XL / Navy', model_sku: 'X' },
  ]);
  assert.equal(rows[0].name, 'Zaneva Curve — Sidney Vest Outer — XL / Navy');
});

test('a nameless variation falls back to the item name rather than going blank', () => {
  const rows = buildListingRows(item({ has_model: true }), [
    { model_id: 9, model_sku: 'X' },
  ]);
  assert.equal(rows[0].name, 'Zaneva Curve — Sidney Vest Outer');
});

test('a model without its own SKU inherits the item SKU', () => {
  const rows = buildListingRows(item({ has_model: true }), [{ model_id: 9, model_name: 'M' }]);
  assert.equal(rows[0].sku, 'Y-Sidney');
});

test('unreadable stock is null, never a confident zero', () => {
  // A 0 shown next to a product that actually has stock is the one outcome
  // worth avoiding: it reads as "sold out" and is acted on.
  assert.equal(readStock({}), null);
  assert.equal(readStock({ stock_info_v2: {} }), null);
  assert.equal(readStock({ stock_info_v2: { summary_info: { total_available_stock: 0 } } }), 0);
});

test('the older stock_info shape is still understood', () => {
  const legacy = { stock_info: [{ stock_type: 1, current_stock: 99 }, { stock_type: 2, current_stock: 12 }] };
  assert.equal(readStock(legacy), 12, 'seller stock (type 2) wins over the platform total');
});

test('unreadable price is null, and zero is kept as a real price', () => {
  assert.equal(readPrice({}), null);
  assert.equal(readPrice({ price_info: [] }), null);
  assert.equal(readPrice({ price_info: [{ current_price: 0 }] }), 0);
  assert.equal(readPrice({ price_info: [{ original_price: 5000 }] }), 5000,
    'falls back to original_price when there is no current one');
});

test('an item with no image does not invent one', () => {
  const rows = buildListingRows(item({ image: {} }), []);
  assert.equal(rows[0].imageUrl, null);
});

test('a missing name still produces something identifiable', () => {
  const rows = buildListingRows(item({ item_name: undefined }), []);
  assert.equal(rows[0].name, 'Item 111');
});
