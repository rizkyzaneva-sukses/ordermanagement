'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MASTER_COLUMNS, MASTER_REQUIRED, STOCK_COLUMNS, STOCK_REQUIRED,
  parseStockCell, readRows, planMasterImport, planStockImport,
} = require('../src/services/masterImport.js');
const { buildWorkbook, readSheet, cellText } = require('../src/services/importWorkbook.js');
const { normaliseSku } = require('../src/services/productMapping.js');

// Belva Vest in two shops, plus the Airflow jacket and its "+ Jogger" bundle.
const listings = [
  { id: 'a1', storeId: 'curve', itemId: '900', modelId: '1', name: 'Belva Vest — Black', itemName: 'Belva Vest', modelName: 'Black', stock: 99, productId: null },
  { id: 'a2', storeId: 'curve', itemId: '900', modelId: '2', name: 'Belva Vest — White', itemName: 'Belva Vest', modelName: 'White', stock: 81, productId: null },
  { id: 'b1', storeId: 'zaneva', itemId: '500', modelId: '1', name: 'Belva Vest — Black', itemName: 'Belva Vest', modelName: 'Black', stock: 90, productId: null },
  { id: 'j1', storeId: 'kids', itemId: '700', modelId: '1', name: 'Airflow — Hitam M', itemName: 'Airflow', modelName: 'Hitam M', stock: 12, productId: null },
  { id: 'j2', storeId: 'kids', itemId: '700', modelId: '2', name: 'Airflow — Hitam M + Jogger', itemName: 'Airflow', modelName: 'Hitam M + Jogger', stock: 8, productId: null },
  { id: 'm1', storeId: 'curve', itemId: '901', modelId: '', name: 'Zora Cap', itemName: 'Zora Cap', modelName: null, stock: 17, productId: 'p-zora' },
];
const byId = new Map(listings.map(l => [l.id, l]));
const none = new Map();

const row = (n, listingId, masterSku, extra = {}) => ({ row: n, listingId, masterSku, masterName: '', startStock: '', ...extra });

test('a stock cell is plain digits or blank — "1.200" is refused, not read as 1', () => {
  assert.deepEqual(parseStockCell(''), { value: null });
  assert.deepEqual(parseStockCell(' 40 '), { value: 40 });
  assert.ok(parseStockCell('1.200').error);
  assert.ok(parseStockCell('12,5').error);
  assert.ok(parseStockCell('-3').error);
});

test('readRows finds columns by name, ignoring case, brackets and order', () => {
  const matrix = [
    { row: 1, cells: ['master sku', 'Toko', 'id', 'STOK AWAL'] },
    { row: 2, cells: ['BELVA-BLACK', 'Curve', 'a1', '5'] },
    { row: 3, cells: ['', '', '', ''] },
  ];
  const { rows, error } = readRows(matrix, MASTER_COLUMNS, MASTER_REQUIRED);
  assert.equal(error, undefined);
  assert.deepEqual(rows, [{ row: 2, masterSku: 'BELVA-BLACK', store: 'Curve', listingId: 'a1', startStock: '5' }]);
});

test('a file without the ID column is refused as the wrong file', () => {
  const { error } = readRows([{ row: 1, cells: ['Master SKU', 'Stok'] }], MASTER_COLUMNS, MASTER_REQUIRED);
  assert.match(error, /"ID \(jangan diubah\)"/);
});

test('one SKU across two shops becomes one master starting from the smaller stock', () => {
  const plan = planMasterImport([
    row(2, 'a1', 'BELVA-BLACK'),
    row(3, 'b1', 'belva-black '),
  ], byId, none);

  assert.equal(plan.ok, true);
  assert.equal(plan.counts.creates, 1);
  const [c] = plan.parents[0].creates;
  assert.equal(c.stock, 90);
  assert.deepEqual(c.spread, { min: 90, max: 99 });
  assert.deepEqual(c.listingIds, ['a1', 'b1']);
  assert.equal(c.stores, 2);
  // Curve holds 99, so it has to be told 90.
  assert.equal(c.needsPush, true);
});

test('a typed Stok Awal wins over the listings', () => {
  const plan = planMasterImport([
    row(2, 'a1', 'BELVA-BLACK', { startStock: '50' }),
    row(3, 'b1', 'BELVA-BLACK'),
  ], byId, none);
  assert.equal(plan.parents[0].creates[0].stock, 50);
  assert.equal(plan.parents[0].creates[0].typed, true);
});

test('two different Stok Awal for one new SKU is an error on both rows', () => {
  const plan = planMasterImport([
    row(2, 'a1', 'BELVA-BLACK', { startStock: '50' }),
    row(3, 'b1', 'BELVA-BLACK', { startStock: '40' }),
  ], byId, none);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.errors.map(e => e.row), [2, 3]);
});

test('variations of one item on one SKU are refused unless shareSku', () => {
  const rows = [row(2, 'j1', 'AIRFLOW-HITAM-M'), row(3, 'j2', 'AIRFLOW-HITAM-M')];

  const refused = planMasterImport(rows, byId, none);
  assert.equal(refused.ok, false);
  assert.equal(refused.errors[0].code, 'SHARED_SKU');
  assert.equal(refused.errors[0].row, 3);
  assert.equal(refused.sharedConflicts, 1);

  const shared = planMasterImport(rows, byId, none, { shareSku: true });
  assert.equal(shared.ok, true);
  const [c] = shared.parents[0].creates;
  assert.deepEqual(c.listingIds, ['j1', 'j2']);
  assert.equal(c.stock, 8);
  assert.equal(c.variantName, 'Hitam M');
});

test('an existing SKU only gains listings; its stock and a typed Stok Awal are left alone', () => {
  const existing = new Map([[normaliseSku('BELVA-BLACK'), { id: 'p-belva', masterSku: 'BELVA-BLACK', stock: 90 }]]);
  const plan = planMasterImport([
    row(2, 'a1', 'BELVA-BLACK', { startStock: '5' }),
    row(3, 'b1', 'BELVA-BLACK'),
  ], byId, existing);

  assert.equal(plan.ok, true);
  assert.equal(plan.counts.creates, 0);
  assert.deepEqual(plan.binds.map(b => b.listingId), ['a1', 'b1']);
  assert.equal(plan.warnings.length, 1);
  // a1 holds 99 on Shopee, master says 90.
  assert.deepEqual(plan.pushIds, ['p-belva']);
});

test('blank Master SKU and already-mapped listings are skipped, not errors', () => {
  const plan = planMasterImport([
    row(2, 'a1', ''),
    row(3, 'm1', 'ZORA-CAP'),
  ], byId, none);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.skipped.map(s => s.reason), ['Master SKU kosong', 'Sudah punya master']);
  assert.equal(plan.counts.creates, 0);
});

test('unknown, out-of-scope or repeated IDs are errors naming the row', () => {
  const plan = planMasterImport([
    row(2, 'nope', 'X'),
    row(3, 'a1', 'BELVA-BLACK'),
    row(4, 'a1', 'BELVA-BLACK'),
    row(5, '', 'Y'),
  ], byId, none);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.errors.map(e => e.row), [2, 4, 5]);
});

test('rows are grouped under a parent by Nama Master Produk', () => {
  const plan = planMasterImport([
    row(2, 'a1', 'BELVA-BLACK', { masterName: 'Belva Vest' }),
    row(3, 'a2', 'BELVA-WHITE', { masterName: 'belva vest' }),
    row(4, 'j1', 'AIRFLOW-HITAM-M'),
  ], byId, none);
  assert.deepEqual(plan.parents.map(p => [p.name, p.creates.length]), [['Belva Vest', 2], ['Airflow', 1]]);
});

test('no push is needed when the shop already holds the starting stock', () => {
  const plan = planMasterImport([row(2, 'a2', 'BELVA-WHITE')], byId, none);
  assert.equal(plan.parents[0].creates[0].needsPush, false);
  assert.equal(plan.counts.push, 0);
});

const masters = new Map([
  ['belva-black', { id: 'p1', masterSku: 'BELVA-BLACK', name: 'Belva — Black', stock: 90 }],
  ['belva-white', { id: 'p2', masterSku: 'BELVA-WHITE', name: 'Belva — White', stock: 81 }],
  ['zora-cap', { id: 'p3', masterSku: 'ZORA-CAP', name: 'Zora Cap', stock: 17 }],
]);
const srow = (n, masterSku, newStock, currentStock = '') => ({ row: n, masterSku, newStock, currentStock });

test('Import Stok sets the counted number and skips blanks and unchanged rows', () => {
  const plan = planStockImport([
    srow(2, 'BELVA-BLACK', '120', '90'),
    srow(3, 'belva-white', '81', '81'),
    srow(4, 'ZORA-CAP', '', '17'),
  ], masters);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changes.map(c => [c.productId, c.from, c.to]), [['p1', 90, 120]]);
  assert.equal(plan.counts.unchanged, 1);
  assert.equal(plan.counts.blank, 1);
});

test('a stock that moved since export is flagged, not refused', () => {
  const plan = planStockImport([srow(2, 'BELVA-BLACK', '100', '95')], masters);
  assert.equal(plan.ok, true);
  assert.equal(plan.changes[0].drifted, true);
});

test('Import Stok refuses unknown SKUs, bad numbers and conflicting duplicates', () => {
  const plan = planStockImport([
    srow(2, 'NOPE', '5'),
    srow(3, 'BELVA-BLACK', '1.200'),
    srow(4, 'ZORA-CAP', '10'),
    srow(5, 'zora-cap', '11'),
    srow(6, '', '4'),
  ], masters);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.errors.map(e => e.row), [2, 3, 5, 6]);
});

test('a template survives a round trip through .xlsx, leading zeros included', async () => {
  const buffer = await buildWorkbook({
    sheet: 'Master',
    columns: MASTER_COLUMNS,
    rows: [{ store: 'Curve', product: 'Belva Vest', variant: 'Black', sku: '001234', listingStock: 99, masterSku: '001234', masterName: 'Belva Vest', startStock: '', listingId: 'a1' }],
    guide: ['Petunjuk'],
  });
  const { rows, error } = readRows(await readSheet(buffer), MASTER_COLUMNS, MASTER_REQUIRED);
  assert.equal(error, undefined);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].masterSku, '001234');
  assert.equal(rows[0].listingId, 'a1');
  assert.equal(rows[0].listingStock, '99');
});

test('the stock export reads back with its own columns', async () => {
  const buffer = await buildWorkbook({
    sheet: 'Stok',
    columns: STOCK_COLUMNS,
    rows: [{ masterSku: 'BELVA-BLACK', masterName: 'Belva', variant: 'Black', bound: 3, currentStock: 90, newStock: 120 }],
    guide: ['Petunjuk'],
  });
  const { rows } = readRows(await readSheet(buffer), STOCK_COLUMNS, STOCK_REQUIRED);
  assert.deepEqual([rows[0].masterSku, rows[0].currentStock, rows[0].newStock], ['BELVA-BLACK', '90', '120']);
});

test('a file that is not an .xlsx is a 400, not a crash', async () => {
  await assert.rejects(readSheet(Buffer.from('Master SKU;Stok\nA;1')), (err) => err.status === 400);
});

test('cellText reads the shapes Excel hands back', () => {
  assert.equal(cellText({ richText: [{ text: 'BEL' }, { text: 'VA' }] }), 'BELVA');
  assert.equal(cellText({ formula: 'A1', result: 7 }), '7');
  assert.equal(cellText({ text: 'link', hyperlink: 'x' }), 'link');
  assert.equal(cellText(null), '');
});
