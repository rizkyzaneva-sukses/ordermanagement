'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');

const { mergeAwbDocuments } = require('../src/services/fulfillment.js');

/** A real PDF with `pages` blank pages, so the merge is exercised for real. */
const pdfWithPages = async (pages) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
  return {
    buffer: Buffer.from(await doc.save()),
    format: 'pdf',
    documentType: 'THERMAL_AIR_WAYBILL',
  };
};

test('per-courier documents merge into one PDF, keeping every label', async () => {
  // The whole point of splitting by channel: nothing may be dropped on the way
  // back, or the operator ships a package whose label never printed.
  const merged = await mergeAwbDocuments([await pdfWithPages(3), await pdfWithPages(2)]);

  assert.equal(merged.format, 'pdf');
  const reloaded = await PDFDocument.load(merged.buffer);
  assert.equal(reloaded.getPageCount(), 5);
});

test('page order follows the order the documents were fetched in', async () => {
  const first = await PDFDocument.create();
  first.addPage([111, 111]);
  const second = await PDFDocument.create();
  second.addPage([222, 222]);

  const merged = await mergeAwbDocuments([
    { buffer: Buffer.from(await first.save()), format: 'pdf', documentType: 'T' },
    { buffer: Buffer.from(await second.save()), format: 'pdf', documentType: 'T' },
  ]);

  const reloaded = await PDFDocument.load(merged.buffer);
  assert.equal(Math.round(reloaded.getPage(0).getWidth()), 111);
  assert.equal(Math.round(reloaded.getPage(1).getWidth()), 222);
});

test('the document type of the batch is preserved', async () => {
  const merged = await mergeAwbDocuments([await pdfWithPages(1), await pdfWithPages(1)]);
  assert.equal(merged.documentType, 'THERMAL_AIR_WAYBILL');
});

test('a non-PDF format is refused rather than concatenated', async () => {
  // Shopee serves HTML and ZIP in some markets (KB §7.2). Gluing those together
  // yields a file that opens to a fraction of the labels — silent data loss on a
  // page the operator is about to print and ship from.
  await assert.rejects(
    () => mergeAwbDocuments([
      { buffer: Buffer.from('<html>label</html>'), format: 'html', documentType: 'T' },
      { buffer: Buffer.from('<html>label</html>'), format: 'html', documentType: 'T' },
    ]),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /hanya PDF yang bisa digabung/);
      return true;
    },
  );
});

test('a mix of PDF and non-PDF is refused', async () => {
  const pdf = await pdfWithPages(1);
  await assert.rejects(
    () => mergeAwbDocuments([
      pdf,
      { buffer: Buffer.from('PK\x03\x04'), format: 'zip', documentType: 'T' },
    ]),
    /hanya PDF yang bisa digabung/,
  );
});

// ── Splitting a selection into requests Shopee will accept ───────────────────

const { planAwbBatches } = require('../src/services/fulfillment.js');

const rowsFor = (count, storeId, logisticsChannelId, prefix = storeId) =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, storeId, logisticsChannelId }));

test('more than 50 packages are cut into Shopee-sized requests, none lost', () => {
  const rows = rowsFor(180, 's1', 80005);
  const batches = planAwbBatches(rows);

  assert.deepEqual(batches.map(b => b.rows.length), [50, 50, 50, 30]);
  assert.deepEqual(batches.flatMap(b => b.rows.map(r => r.id)), rows.map(r => r.id));
});

test('stores and couriers never share a request', () => {
  const rows = [
    ...rowsFor(3, 's1', 80005),
    ...rowsFor(2, 's2', 80005),
    ...rowsFor(4, 's1', 80088, 's1b'),
  ];
  const batches = planAwbBatches(rows);

  assert.equal(batches.length, 3);
  for (const b of batches) {
    assert.equal(new Set(b.rows.map(r => r.storeId)).size, 1);
    assert.equal(new Set(b.rows.map(r => r.logisticsChannelId)).size, 1);
  }
});

test('an unrecorded courier is never lumped with another row', () => {
  const batches = planAwbBatches([
    { id: 'a', storeId: 's1', logisticsChannelId: null },
    { id: 'b', storeId: 's1', logisticsChannelId: null },
    { id: 'c', storeId: 's1', logisticsChannelId: 80005 },
  ]);
  assert.deepEqual(batches.map(b => b.rows.map(r => r.id)), [['a'], ['b'], ['c']]);
});
