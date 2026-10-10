'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { orderLines, hasShipped, planTake, normaliseModelId } = require('../src/services/orderStock.js');

const item = (itemId, modelId, quantity, orderItemId) => ({ itemId, modelId, quantity, orderItemId });

test('one package: each variation once, with its quantity', () => {
  const lines = orderLines([[
    item(42632122630, 316130889463, 2, 1),
    item(42632122630, 316130889462, 1, 2),
  ]]);

  assert.deepEqual(lines, [
    { itemId: '42632122630', modelId: '316130889463', quantity: 2 },
    { itemId: '42632122630', modelId: '316130889462', quantity: 1 },
  ]);
});

test('a split order repeating the same order line on two packages counts it once', () => {
  // Package rows are matched back to the order's item list, so both carry the
  // full order line. Counting per package would take 4 for an order of 2.
  const line = item(1, 5, 2, 77);
  const lines = orderLines([[line], [{ ...line }]]);

  assert.deepEqual(lines, [{ itemId: '1', modelId: '5', quantity: 2 }]);
});

test('package items Shopee did not match (no orderItemId) are summed', () => {
  const lines = orderLines([[item(1, 5, 1)], [item(1, 5, 2)]]);

  assert.deepEqual(lines, [{ itemId: '1', modelId: '5', quantity: 3 }]);
});

test('two order lines of the same variation add up', () => {
  // e.g. one bought at normal price and one in a bundle deal
  const lines = orderLines([[item(1, 5, 1, 10), item(1, 5, 2, 11)]]);

  assert.deepEqual(lines, [{ itemId: '1', modelId: '5', quantity: 3 }]);
});

test('model 0 from Shopee matches a listing without variations', () => {
  assert.equal(normaliseModelId(0), '');
  assert.equal(normaliseModelId('0'), '');
  assert.equal(normaliseModelId(null), '');
  assert.equal(normaliseModelId(316130889463), '316130889463');
  assert.deepEqual(orderLines([[item(9, 0, 1, 1)]]), [{ itemId: '9', modelId: '', quantity: 1 }]);
});

test('lines without an item id or with no quantity are ignored', () => {
  assert.deepEqual(orderLines([[{ name: 'x', quantity: 1 }, item(1, 5, 0, 1)], 'not-an-array']), []);
});

test('taking stock floors at 0 and reports how much was short', () => {
  assert.deepEqual(planTake(10, 3), { next: 7, delta: -3, short: 0 });
  assert.deepEqual(planTake(1, 3), { next: 0, delta: -1, short: 2 });
  assert.deepEqual(planTake(0, 2), { next: 0, delta: 0, short: 2 });
});

test('shipped: by order status, by logistics status, or remembered from earlier', () => {
  assert.equal(hasShipped([{ status: 'CANCELLED', logisticsStatus: 'LOGISTICS_REQUEST_CANCELED' }]), false);
  assert.equal(hasShipped([{ status: 'CANCELLED', logisticsStatus: 'LOGISTICS_READY' }]), false);
  // Failed delivery between two syncs: never seen as SHIPPED, but logistics says so.
  assert.equal(hasShipped([{ status: 'CANCELLED', logisticsStatus: 'LOGISTICS_DELIVERY_FAILED' }]), true);
  assert.equal(hasShipped([{ status: 'CANCELLED', logisticsStatus: 'LOGISTICS_COD_REJECTED' }]), true);
  assert.equal(hasShipped([{ status: 'CANCELLED', logisticsStatus: null, stockShippedAt: new Date() }]), true);
  assert.equal(hasShipped([{ status: 'TO_RETURN', logisticsStatus: null }]), true);
  // One package of a split order out of the door is enough.
  assert.equal(hasShipped([
    { status: 'CANCELLED', logisticsStatus: 'LOGISTICS_READY' },
    { status: 'CANCELLED', logisticsStatus: 'LOGISTICS_PICKUP_DONE' },
  ]), true);
});
