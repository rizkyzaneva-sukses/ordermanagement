'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPEE_PARTNER_ID = process.env.SHOPEE_PARTNER_ID || '1';
process.env.SHOPEE_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || 'test-key';

const { planStockRefresh } = require('../src/services/productSync.js');

test('an item whose rows carry no model is read at item level', () => {
  const { withModels, withoutModels } = planStockRefresh([
    { itemId: '111', modelId: '' },
  ]);
  assert.deepEqual(withModels, []);
  assert.deepEqual(withoutModels, ['111']);
});

test('an item with variations is read through get_model_list, once', () => {
  // Three rows, one item, one call — the saving this whole path exists for.
  const { withModels, withoutModels } = planStockRefresh([
    { itemId: '222', modelId: '1' },
    { itemId: '222', modelId: '2' },
    { itemId: '222', modelId: '3' },
  ]);
  assert.deepEqual(withModels, ['222']);
  assert.deepEqual(withoutModels, []);
});

test('one model among plain rows makes the whole item multi-variant', () => {
  // A listing that gained variations since the last catalogue pull still has its
  // old model-less row. Reading that item at item level would fetch the total
  // across its variations and write that inflated figure onto every row.
  const { withModels, withoutModels } = planStockRefresh([
    { itemId: '333', modelId: '' },
    { itemId: '333', modelId: '9' },
  ]);
  assert.deepEqual(withModels, ['333']);
  assert.deepEqual(withoutModels, []);
});

test('mixed catalogue splits into the two endpoints without losing an item', () => {
  const listings = [
    { itemId: '1', modelId: '' },
    { itemId: '2', modelId: 'a' },
    { itemId: '2', modelId: 'b' },
    { itemId: '3', modelId: '' },
    { itemId: '4', modelId: 'z' },
  ];
  const { withModels, withoutModels } = planStockRefresh(listings);

  assert.deepEqual(withModels.sort(), ['2', '4']);
  assert.deepEqual(withoutModels.sort(), ['1', '3']);

  // Every distinct item lands in exactly one bucket: an item missed here is a
  // listing whose stock silently never refreshes.
  const planned = [...withModels, ...withoutModels];
  assert.equal(planned.length, new Set(listings.map(l => l.itemId)).size);
  assert.equal(new Set(planned).size, planned.length);
});

test('an empty catalogue plans no calls at all', () => {
  const { withModels, withoutModels } = planStockRefresh([]);
  assert.deepEqual(withModels, []);
  assert.deepEqual(withoutModels, []);
});
