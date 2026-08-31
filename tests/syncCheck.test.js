'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSyncCheck, isConsistent } = require('../src/utils/syncCheck.js');

const shopee = (pairs) => new Map(Object.entries(pairs));
const local = (pairs) => Object.entries(pairs).map(([orderId, status]) => ({ orderId, status }));
const rowFor = (check, status) => check.statuses.find((s) => s.status === status);

test('a run that agrees with Shopee reports a match', () => {
  const check = buildSyncCheck({
    shopeeStatuses: shopee({ A: 'READY_TO_SHIP', B: 'SHIPPED' }),
    localRows: local({ A: 'READY_TO_SHIP', B: 'SHIPPED' }),
  });
  assert.equal(check.matched, true);
  assert.equal(check.missingLocally, 0);
});

test('the real drift: Shopee has shipped it, we still hold it as processed', () => {
  // The 52/50 case. This is the one thing the panel must never miss.
  const check = buildSyncCheck({
    shopeeStatuses: shopee({ A: 'SHIPPED', B: 'SHIPPED' }),
    localRows: local({ A: 'SHIPPED', B: 'PROCESSED' }),
  });
  const row = rowFor(check, 'SHIPPED');
  assert.equal(row.shopee, 2);
  assert.equal(row.agreed, 1);
  assert.equal(row.behind, 1);
  assert.deepEqual(row.behindStatuses, { PROCESSED: 1 });
  assert.equal(check.matched, false);
});

test("Shopee's coarser list buckets are not treated as disagreements", () => {
  // Straight from a live shop: 498 orders listed under SHIPPED whose details
  // were SHIPPED, TO_CONFIRM_RECEIVE and TO_RETURN. Same parcels, named two
  // ways — reporting four missing orders there is how a trust indicator loses
  // the trust it was built for.
  const check = buildSyncCheck({
    shopeeStatuses: shopee({ A: 'SHIPPED', B: 'SHIPPED', C: 'SHIPPED', D: 'SHIPPED' }),
    localRows: local({ A: 'SHIPPED', B: 'TO_CONFIRM_RECEIVE', C: 'TO_CONFIRM_RECEIVE', D: 'TO_RETURN' }),
  });
  assert.equal(check.matched, true);
  assert.equal(rowFor(check, 'SHIPPED').behind, 0);
});

test('a pending cancellation laid over a processed order is consistent', () => {
  // "Minta Batal +1 / Sudah Diatur −1" appeared on three shops at once, always
  // summing to zero: Shopee keeps listing such an order under its fulfilment
  // status while the detail reports IN_CANCEL.
  const check = buildSyncCheck({
    shopeeStatuses: shopee({ A: 'PROCESSED', B: 'PROCESSED' }),
    localRows: local({ A: 'PROCESSED', B: 'IN_CANCEL' }),
  });
  assert.equal(check.matched, true);
});

test('data further along than the list is not an error', () => {
  // The list is a snapshot from the start of the run; the detail read that
  // followed is newer by definition. Warning about our own data being more
  // current would be pure noise.
  assert.equal(isConsistent('PROCESSED', 'SHIPPED'), true);
  assert.equal(isConsistent('READY_TO_SHIP', 'CANCELLED'), true);
  // ...but being behind is exactly what we are looking for.
  assert.equal(isConsistent('SHIPPED', 'PROCESSED'), false);
  assert.equal(isConsistent('CANCELLED', 'READY_TO_SHIP'), false);
});

test('a status nobody here has seen before is flagged, not waved through', () => {
  assert.equal(isConsistent('SHIPPED', 'SOME_NEW_SHOPEE_STATUS'), false);
  assert.equal(isConsistent('SOME_NEW_SHOPEE_STATUS', 'SHIPPED'), false);
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
  const check = buildSyncCheck({
    shopeeStatuses: shopee({ A: 'READY_TO_SHIP' }),
    localRows: local({ A: 'READY_TO_SHIP', B: 'SHIPPED' }),
    unanswered: ['SHIPPED'],
  });
  const row = rowFor(check, 'SHIPPED');
  assert.equal(row.unanswered, true);
  assert.equal(row.shopee, null, 'Shopee answered nothing, which is not zero');
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
  const check = buildSyncCheck({
    shopeeStatuses: new Map([['A', 'READY_TO_SHIP'], ['B', null]]),
    localRows: local({ A: 'READY_TO_SHIP', B: 'READY_TO_SHIP' }),
  });
  assert.equal(check.statuses.length, 1);
  assert.equal(check.matched, true);
});
