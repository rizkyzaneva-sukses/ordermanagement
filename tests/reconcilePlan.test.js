'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planReconciliation, SETTLING_STATUSES } = require('../src/services/syncDirect.js');

const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

test('shipped orders are re-read with whatever budget is left over', () => {
  const plan = planReconciliation(ids('act', 30), ids('ship', 50), 100);
  assert.equal(plan.orderSns.length, 80);
  assert.equal(plan.fromSettling, 50);
  assert.equal(plan.deferred, 0);
});

test('orders still awaiting an operator take the budget first', () => {
  // The expensive drift is an operator acting on a status that was never
  // refreshed; a shipped order drifting only makes a number wrong.
  const plan = planReconciliation(ids('act', 100), ids('ship', 500), 100);
  assert.equal(plan.orderSns.length, 100);
  assert.equal(plan.fromSettling, 0);
  assert.ok(plan.orderSns.every((sn) => sn.startsWith('act-')));
});

test('a backlog too large for one run is reported, not silently dropped', () => {
  const plan = planReconciliation(ids('act', 120), ids('ship', 80), 100);
  assert.equal(plan.orderSns.length, 100);
  // 20 actionable left over plus all 80 shipped ones.
  assert.equal(plan.deferred, 100);
});

test('shipped orders alone still get worked through', () => {
  const plan = planReconciliation([], ids('ship', 250), 100);
  assert.equal(plan.orderSns.length, 100);
  assert.equal(plan.fromSettling, 100);
  assert.equal(plan.deferred, 150);
});

test('nothing stale means nothing is re-read', () => {
  const plan = planReconciliation([], [], 100);
  assert.deepEqual(plan.orderSns, []);
  assert.equal(plan.deferred, 0);
});

test('both halves of "sudah dikirim" are watched', () => {
  // TO_CONFIRM_RECEIVE is the same tab as SHIPPED everywhere else in the app,
  // so leaving it out would strand exactly the orders closest to completing.
  assert.deepEqual(SETTLING_STATUSES, ['SHIPPED', 'TO_CONFIRM_RECEIVE']);
});
