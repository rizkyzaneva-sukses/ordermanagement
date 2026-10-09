'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planStockPush } = require('../src/services/productMapping.js');
const { readUpdateStockResult } = require('../src/services/stockPush.js');

const listing = (id, storeId, itemId, modelId, stock) => ({ id, storeId, itemId, modelId, stock });

test('variations of one item in one shop share a single call', () => {
  // Five colours of Zora Cap in one shop is one update_stock, not five.
  const plan = planStockPush([
    listing('l1', 's1', 'item1', 'red', 146),
    listing('l2', 's1', 'item1', 'white', 17),
    listing('l3', 's1', 'item1', 'beige', 144),
  ]);

  assert.deepEqual([...plan.keys()], ['s1']);
  assert.deepEqual(plan.get('s1'), [{
    itemId: 'item1',
    models: [
      { listingId: 'l1', modelId: 'red', stock: 146 },
      { listingId: 'l2', modelId: 'white', stock: 17 },
      { listingId: 'l3', modelId: 'beige', stock: 144 },
    ],
  }]);
});

test('each shop and each item gets its own call', () => {
  const plan = planStockPush([
    listing('l1', 's1', 'item1', 'a', 1),
    listing('l2', 's2', 'item9', 'a', 1),
    listing('l3', 's1', 'item2', '', 5),
  ]);

  assert.deepEqual(plan.get('s1').map(c => c.itemId), ['item1', 'item2']);
  assert.deepEqual(plan.get('s2').map(c => c.itemId), ['item9']);
});

test('an item with more models than Shopee takes is split into batches', () => {
  const many = Array.from({ length: 5 }, (_, i) => listing(`l${i}`, 's1', 'item1', `m${i}`, i));
  const calls = planStockPush(many, 2).get('s1');

  assert.deepEqual(calls.map(c => c.models.length), [2, 2, 1]);
  assert.ok(calls.every(c => c.itemId === 'item1'));
});

const sent = [
  { listingId: 'l1', modelId: '316130889462', stock: 146 },
  { listingId: 'l2', modelId: '316130889463', stock: 17 },
];

test('success_list marks a listing pushed with the number we sent', () => {
  const { pushed, failed } = readUpdateStockResult(sent, {
    success_list: [
      { model_id: 316130889462, stock: 146 },
      { model_id: 316130889463, stock: 17 },
    ],
    failure_list: [],
  });

  assert.deepEqual(pushed, [{ listingId: 'l1', stock: 146 }, { listingId: 'l2', stock: 17 }]);
  assert.deepEqual(failed, []);
});

test('failure_list keeps Shopee\'s own reason', () => {
  const { pushed, failed } = readUpdateStockResult(sent, {
    success_list: [{ model_id: 316130889462, stock: 146 }],
    failure_list: [{ model_id: 316130889463, failed_reason: 'Stock is locked by promotion' }],
  });

  assert.deepEqual(pushed, [{ listingId: 'l1', stock: 146 }]);
  assert.deepEqual(failed, [{ listingId: 'l2', reason: 'Stock is locked by promotion' }]);
});

test('a model Shopee did not mention is failed, not assumed done', () => {
  const { pushed, failed } = readUpdateStockResult(sent, {
    success_list: [{ model_id: 316130889462, stock: 146 }],
  });

  assert.equal(pushed.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].listingId, 'l2');
});

test('a listing without variations is matched as model 0', () => {
  const { pushed } = readUpdateStockResult(
    [{ listingId: 'solo', modelId: '', stock: 9 }],
    { success_list: [{ model_id: 0, stock: 9 }] },
  );

  assert.deepEqual(pushed, [{ listingId: 'solo', stock: 9 }]);
});

test('no response at all fails every model', () => {
  const { pushed, failed } = readUpdateStockResult(sent, undefined);

  assert.equal(pushed.length, 0);
  assert.deepEqual(failed.map(f => f.listingId), ['l1', 'l2']);
});
