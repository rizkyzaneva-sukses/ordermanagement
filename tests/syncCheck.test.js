'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSyncCheck } = require('../src/utils/syncCheck.js');

const shopee = (pairs) => new Map(Object.entries(pairs));
const local = (pairs) => Object.entries(pairs).map(([orderId, status]) => ({ orderId, status }));

test('a run that agrees with Shopee reports a match', () => {
  const check = buildSyncCheck({
    shopeeStatuses: shopee({ A: 'READY_TO_SHIP', B: 'SHIPPED' }),
    localRows: local({ A: 'READY_TO_SHIP', B: 'SHIPPED' }),
  });
  assert.equal(check.matched, true);
  assert.equal(check.missingLocally, 0);
});

test('the real case: two orders Shopee shipped that are still stored as processed', () => {
  // 52/7 here against 50/9 in Seller Centre — the counts move in opposite
  // directions by the same amount, which is what identifies it as a status
  // disagreement rather than missing orders.
  const shopeeStatuses = new Map();
  const localRows = [];
  for (let i = 0; i < 50; i++) { shopeeStatuses.set(`p${i}`, 'PROCESSED'); localRows.push({ orderId: `p${i}`, status: 'PROCESSED' }); }
  for (let i = 0; i < 7; i++) { shopeeStatuses.set(`s${i}`, 'SHIPPED'); localRows.push({ orderId: `s${i}`, status: 'SHIPPED' }); }
  // The two Shopee moved on from, which we still hold as PROCESSED.
  for (let i = 0; i < 2; i++) { shopeeStatuses.set(`x${i}`, 'SHIPPED'); localRows.push({ orderId: `x${i}`, status: 'PROCESSED' }); }

  const check = buildSyncCheck({ shopeeStatuses, localRows });
  const by = Object.fromEntries(check.statuses.map((s) => [s.status, s]));

  assert.equal(by.PROCESSED.shopee, 50);
  assert.equal(by.PROCESSED.local, 52);
  assert.equal(by.PROCESSED.diff, 2);
  assert.equal(by.SHIPPED.shopee, 9);
  assert.equal(by.SHIPPED.local, 7);
  assert.equal(by.SHIPPED.diff, -2);
  assert.equal(check.matched, false);
});

test('an order Shopee named but nothing stored is counted separately', () => {
  // Not a status disagreement — there is no row at all, which is a different
  // fault with a different fix.
  const check = buildSyncCheck({
    shopeeStatuses: shopee({ A: 'CANCELLED', B: 'CANCELLED' }),
    localRows: local({ A: 'CANCELLED' }),
  });
  assert.equal(check.missingLocally, 1);
  assert.equal(check.matched, false);
});

test('a failed pass is reported as unanswered, never as a shortfall', () => {
  // Shopee did not say "zero shipped orders", it did not answer at all.
  // Rendering that as a deficit would raise an alarm about the data when the
  // fault is in the question.
  const check = buildSyncCheck({
    shopeeStatuses: shopee({ A: 'READY_TO_SHIP' }),
    localRows: local({ A: 'READY_TO_SHIP', B: 'SHIPPED' }),
    unanswered: ['SHIPPED'],
  });
  const shippedRow = check.statuses.find((s) => s.status === 'SHIPPED');
  assert.equal(shippedRow.unanswered, true);
  assert.equal(check.matched, false, 'an incomplete run must never read as verified');
});

test('rows Shopee did not mention are flagged, but only while they still need work', () => {
  const check = buildSyncCheck({
    shopeeStatuses: shopee({ A: 'READY_TO_SHIP' }),
    localRows: local({ A: 'READY_TO_SHIP', OLD: 'PROCESSED', DONE: 'COMPLETED' }),
  });
  // PROCESSED still needs an operator, so its silence matters. COMPLETED does
  // not — every settled order in the database would otherwise be flagged.
  assert.equal(check.staleCandidates, 1);
});

test('order_sns seeded without a status do not distort the tallies', () => {
  // search_package_list contributes order_sns with no status attached; counting
  // those as a status would invent a mismatch out of nothing.
  const check = buildSyncCheck({
    shopeeStatuses: new Map([['A', 'READY_TO_SHIP'], ['B', null]]),
    localRows: local({ A: 'READY_TO_SHIP', B: 'READY_TO_SHIP' }),
  });
  assert.equal(check.statuses.length, 1);
  assert.equal(check.matched, true);
});
