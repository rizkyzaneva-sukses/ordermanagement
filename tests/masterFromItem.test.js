'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  itemNameOf, variantNameOf, planMasterFromItem, normaliseSku,
} = require('../src/services/productMapping.js');

// The item from the Komplace recording of 14 Sep 2026.
const belva = [
  { id: 'l1', itemId: '900', modelId: '1', name: 'Belva Vest — Black', itemName: 'Belva Vest', modelName: 'Black', sku: 'BELVA-BLACK', stock: 99, productId: null },
  { id: 'l2', itemId: '900', modelId: '2', name: 'Belva Vest — Coffee', itemName: 'Belva Vest', modelName: 'Coffee', sku: 'BELVA-COFFEE', stock: 95, productId: null },
  { id: 'l3', itemId: '900', modelId: '3', name: 'Belva Vest — Dusty Pink', itemName: 'Belva Vest', modelName: 'Dusty Pink', sku: 'BELVA-DUSTY', stock: 94, productId: null },
  { id: 'l4', itemId: '900', modelId: '4', name: 'Belva Vest — Red Chilli', itemName: 'Belva Vest', modelName: 'Red Chilli', sku: 'BELVA-RED', stock: 92, productId: null },
  { id: 'l5', itemId: '900', modelId: '5', name: 'Belva Vest — White', itemName: 'Belva Vest', modelName: 'White', sku: 'BELVA-WHITE', stock: 81, productId: null },
];

const byId = (rows) => new Map(rows.map(r => [r.id, r]));
const form = (rows, name = 'Belva Vest') => ({
  name,
  variants: rows.map(r => ({ listingId: r.id, masterSku: r.sku })),
});

test('five variations become five Master SKUs under one parent, not one SKU', () => {
  // The bug this replaces: all five collapsed into a single master.
  const plan = planMasterFromItem(form(belva), byId(belva), new Map());

  assert.equal(plan.ok, true);
  assert.equal(plan.name, 'Belva Vest');
  assert.equal(plan.creates.length, 5);
  assert.deepEqual(plan.creates.map(c => c.masterSku),
    ['BELVA-BLACK', 'BELVA-COFFEE', 'BELVA-DUSTY', 'BELVA-RED', 'BELVA-WHITE']);
  assert.deepEqual(plan.creates.map(c => c.variantName),
    ['Black', 'Coffee', 'Dusty Pink', 'Red Chilli', 'White']);
});

test('starting stock is the listing stock, totalling what Shopee holds', () => {
  // Recording: Daftar Stok 99/95/94/92/81 = 461, same as the Shopee listing.
  const plan = planMasterFromItem(form(belva), byId(belva), new Map());
  assert.deepEqual(plan.creates.map(c => c.stock), [99, 95, 94, 92, 81]);
  assert.equal(plan.creates.reduce((n, c) => n + c.stock, 0), 461);
  assert.equal(plan.unreadStock, 0);
});

test('unreadable listing stock starts at 0 and is counted, not hidden', () => {
  const rows = [{ ...belva[0], stock: null }, belva[1]];
  const plan = planMasterFromItem(form(rows), byId(rows), new Map());
  assert.equal(plan.creates[0].stock, 0);
  assert.equal(plan.unreadStock, 1);
});

test('the operator can rename a Master SKU before saving', () => {
  const input = form(belva);
  input.variants[0].masterSku = '  Belva Vest Black  ';
  const plan = planMasterFromItem(input, byId(belva), new Map());
  assert.equal(plan.creates[0].masterSku, 'Belva Vest Black');
});

test('two variations on one SKU fails the item and names both rows', () => {
  // A model without its own SKU inherits the item SKU, so this is the quiet
  // way five colours still end up on one master.
  const input = form(belva);
  input.variants[1].masterSku = 'belva-black';
  const plan = planMasterFromItem(input, byId(belva), new Map());

  assert.equal(plan.ok, false);
  assert.match(plan.errors.join('\n'), /dipakai dua kali/);
  assert.match(plan.errors.join('\n'), /Black.*Coffee/);
});

// A jacket, and the same jacket sold as a bundle with joggers: one pile of
// jackets behind two Shopee variations that carry the same seller SKU.
const jacket = [
  { id: 'a1', itemId: '5', modelId: '1', name: 'Airflow — Black Anak,L', itemName: 'Airflow', modelName: 'Black Anak,L', sku: 'Airflow Black - L', stock: 12, productId: null },
  { id: 'a2', itemId: '5', modelId: '2', name: 'Airflow — Black + Jogger,L', itemName: 'Airflow', modelName: 'Black + Jogger,L', sku: 'Airflow Black - L', stock: 8, productId: null },
  { id: 'a3', itemId: '5', modelId: '3', name: 'Airflow — Black Anak,M', itemName: 'Airflow', modelName: 'Black Anak,M', sku: 'Airflow Black - M', stock: 9, productId: null },
];
const shared = (rows, extra = {}) => ({ ...form(rows, 'Airflow'), shareSku: true, ...extra });

test('without shareSku a bundle on the jacket\'s SKU still fails the item', () => {
  const plan = planMasterFromItem(form(jacket, 'Airflow'), byId(jacket), new Map());
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join('\n'), /Airflow Black - L.*dipakai dua kali/);
});

test('with shareSku the bundle rides on the jacket\'s master', () => {
  const plan = planMasterFromItem(shared(jacket), byId(jacket), new Map());

  assert.equal(plan.ok, true);
  assert.equal(plan.creates.length, 2, 'one master per SKU, not per row');
  const pair = plan.creates.find(c => c.masterSku === 'Airflow Black - L');
  assert.equal(pair.listingId, 'a1', 'the first row names the master');
  assert.deepEqual(pair.alsoListingIds, ['a2']);
  assert.equal(pair.variantName, 'Black Anak,L');
  assert.equal(plan.shared, 1);
});

test('a shared master starts from the smallest stock, never the largest', () => {
  // 12 jackets on the plain listing, 8 bundles: starting at 12 could sell
  // four more bundles than there are joggers for.
  const plan = planMasterFromItem(shared(jacket), byId(jacket), new Map());
  assert.equal(plan.creates.find(c => c.masterSku === 'Airflow Black - L').stock, 8);
  assert.equal(plan.creates.find(c => c.masterSku === 'Airflow Black - M').stock, 9);
});

test('an unreadable stock in a shared group defers to the readable one', () => {
  const rows = [{ ...jacket[0], stock: null }, jacket[1]];
  const plan = planMasterFromItem(shared(rows), byId(rows), new Map());
  assert.equal(plan.creates[0].stock, 8);
  assert.equal(plan.unreadStock, 0);
});

test('a shared group where nothing reads starts at 0 and is counted once', () => {
  const rows = [{ ...jacket[0], stock: null }, { ...jacket[1], stock: null }];
  const plan = planMasterFromItem(shared(rows), byId(rows), new Map());
  assert.equal(plan.creates[0].stock, 0);
  assert.equal(plan.unreadStock, 1);
});

test('shareSku joins every row of a SKU that already has a master', () => {
  const existing = new Map([[normaliseSku('Airflow Black - L'), { id: 'p-jacket', masterSku: 'Airflow Black - L' }]]);
  const plan = planMasterFromItem(shared(jacket), byId(jacket), existing);

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.binds.map(b => [b.listingId, b.productId]), [['a1', 'p-jacket'], ['a2', 'p-jacket']]);
  assert.equal(plan.creates.length, 1, 'only the M row still needs a master');
});

test('shareSku does not excuse a blank SKU, and different SKUs stay separate', () => {
  const blank = form(jacket, 'Airflow');
  blank.shareSku = true;
  blank.variants[2].masterSku = '  ';
  assert.equal(planMasterFromItem(blank, byId(jacket), new Map()).ok, false);

  const plan = planMasterFromItem(shared(belva), byId(belva), new Map());
  assert.equal(plan.creates.length, 5);
  assert.equal(plan.shared, 0);
});

test('without shareSku nothing is shared even when the plan succeeds', () => {
  const plan = planMasterFromItem(form(belva), byId(belva), new Map());
  assert.equal(plan.shared, 0);
  assert.ok(plan.creates.every(c => c.alsoListingIds.length === 0));
});

test('a blank Master SKU fails the whole item rather than saving the rest', () => {
  const input = form(belva);
  input.variants[2].masterSku = '   ';
  const plan = planMasterFromItem(input, byId(belva), new Map());

  assert.equal(plan.ok, false);
  assert.match(plan.errors[0], /Dusty Pink/);
});

test('a blank parent name is refused', () => {
  const plan = planMasterFromItem(form(belva, '  '), byId(belva), new Map());
  assert.equal(plan.ok, false);
});

test('variations from two different items cannot share a parent', () => {
  const other = { ...belva[0], id: 'x1', itemId: '901', sku: 'OTHER' };
  const rows = [belva[0], other];
  const plan = planMasterFromItem(form(rows), byId(rows), new Map());
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join('\n'), /satu produk/);
});

test('a listing outside the caller\'s shops fails the item', () => {
  const plan = planMasterFromItem(form(belva), byId(belva.slice(1)), new Map());
  assert.equal(plan.ok, false);
  assert.match(plan.errors[0], /l1/);
});

test('an existing SKU (same item in another shop) is joined, not duplicated', () => {
  const existing = new Map([[normaliseSku('BELVA-BLACK'), { id: 'p-black', masterSku: 'BELVA-BLACK' }]]);
  const plan = planMasterFromItem(form(belva), byId(belva), existing);

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.binds, [{ listingId: 'l1', productId: 'p-black', masterSku: 'BELVA-BLACK' }]);
  assert.equal(plan.creates.length, 4);
});

test('an already-mapped listing is left where it is', () => {
  const rows = [{ ...belva[0], productId: 'manual' }, ...belva.slice(1)];
  // Its SKU is not even checked: the operator cannot change it on this form.
  const input = form(rows);
  input.variants[0].masterSku = '';
  const plan = planMasterFromItem(input, byId(rows), new Map());

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.skipped, [{ listingId: 'l1', reason: 'sudah punya master' }]);
  assert.equal(plan.creates.length, 4);
});

test('an item without variations becomes one SKU with no variant name', () => {
  const rows = [{ id: 's1', itemId: '7', modelId: '', name: 'Sidney Vest', itemName: 'Sidney Vest', modelName: null, sku: 'Y-Sidney', stock: 7, productId: null }];
  const plan = planMasterFromItem(form(rows, 'Sidney Vest'), byId(rows), new Map());
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0].variantName, null);
});

// Rows pulled before itemName/modelName existed only carry the joined name.

const legacy = (name, modelId = '1') => ({ name, modelId, itemName: null, modelName: null });

test('item name is recovered from siblings and cut at a whole separator', () => {
  // Common prefix is "Belva Vest — Bl"; a parent by that name would be nonsense.
  assert.equal(itemNameOf([legacy('Belva Vest — Black'), legacy('Belva Vest — Blue')]), 'Belva Vest');
});

test('an item name that has its own separator survives', () => {
  const rows = [
    legacy('Zaneva Curve — Sidney Vest — M / Navy'),
    legacy('Zaneva Curve — Sidney Vest — L / Navy'),
  ];
  assert.equal(itemNameOf(rows), 'Zaneva Curve — Sidney Vest');
  assert.equal(variantNameOf(rows[0], 'Zaneva Curve — Sidney Vest'), 'M / Navy');
});

test('a lone variation drops only the last separator', () => {
  assert.equal(itemNameOf([legacy('Zaneva Curve — Sidney Vest — XL')]), 'Zaneva Curve — Sidney Vest');
});

test('a nameless variation stored under the bare item name is not chopped', () => {
  const rows = [legacy('Zaneva Curve — Sidney Vest'), legacy('Zaneva Curve — Sidney Vest — XL')];
  assert.equal(itemNameOf(rows), 'Zaneva Curve — Sidney Vest');
});

test('a stored item name wins over any derivation', () => {
  assert.equal(itemNameOf([{ name: 'A — B', modelId: '1', itemName: 'A' }]), 'A');
});

test('an item without variations has no variant name', () => {
  assert.equal(variantNameOf({ name: 'Sidney Vest', modelId: '' }, 'Sidney Vest'), null);
});
