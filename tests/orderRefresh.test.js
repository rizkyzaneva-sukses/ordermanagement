'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { orderNeedsDetail } = require('../src/services/orderRefresh.js');

const row = (status, trackingNumber = 'SPXID123') => ({ status, trackingNumber });

test('an order still awaiting action is always fetched', () => {
  for (const status of ['READY_TO_SHIP', 'RETRY_SHIP', 'PROCESSED', 'UNPAID', 'IN_CANCEL']) {
    assert.equal(orderNeedsDetail(status, [row(status)]), true, status);
  }
});

test('a settled order both sides agree on is skipped', () => {
  assert.equal(orderNeedsDetail('COMPLETED', [row('COMPLETED')]), false);
  assert.equal(orderNeedsDetail('CANCELLED', [row('CANCELLED')]), false);
  assert.equal(orderNeedsDetail('SHIPPED', [row('SHIPPED')]), false);
});

test('a settled order the database disagrees about is fetched', () => {
  // This is the drift that started the whole investigation — never skip it.
  assert.equal(orderNeedsDetail('SHIPPED', [row('READY_TO_SHIP')]), true);
  assert.equal(orderNeedsDetail('CANCELLED', [row('PROCESSED')]), true);
});

test('a shipped order with no tracking number is fetched', () => {
  assert.equal(orderNeedsDetail('SHIPPED', [row('SHIPPED', null)]), true);
  assert.equal(orderNeedsDetail('SHIPPED', [row('SHIPPED', '')]), true);
});

test('a delivered order with no tracking number is still skipped', () => {
  // Nothing left to print, so the missing number no longer buys anything.
  assert.equal(orderNeedsDetail('COMPLETED', [row('COMPLETED', null)]), false);
});

test('a split order is fetched when any one package is behind', () => {
  assert.equal(
    orderNeedsDetail('SHIPPED', [row('SHIPPED'), row('PROCESSED')]),
    true);
  assert.equal(
    orderNeedsDetail('SHIPPED', [row('SHIPPED'), row('SHIPPED', null)]),
    true);
  assert.equal(
    orderNeedsDetail('SHIPPED', [row('SHIPPED'), row('SHIPPED')]),
    false);
});

test('an order with no status from the list passes is fetched', () => {
  // search_package_list seeds order_sns without a status
  assert.equal(orderNeedsDetail(null, [row('COMPLETED')]), true);
  assert.equal(orderNeedsDetail(undefined, [row('COMPLETED')]), true);
  assert.equal(orderNeedsDetail('', [row('COMPLETED')]), true);
});

test('an order not in the database yet is fetched', () => {
  assert.equal(orderNeedsDetail('COMPLETED', undefined), true);
  assert.equal(orderNeedsDetail('COMPLETED', []), true);
  assert.equal(orderNeedsDetail('SHIPPED', null), true);
});

test('an unknown status is fetched rather than assumed settled', () => {
  assert.equal(orderNeedsDetail('SOME_NEW_SHOPEE_STATUS', [row('SOME_NEW_SHOPEE_STATUS')]), true);
});

test('a cancellation reaches the database once, then stops costing anything', () => {
  // The gap this closed: an order created and cancelled between two syncs never
  // passed through a status the sync fetched, so it never got a row — which is
  // why the Semua total sat short of Seller Centre by exactly the day's
  // cancellations.
  assert.equal(orderNeedsDetail('CANCELLED', []), true, 'never seen → must be fetched');
  assert.equal(orderNeedsDetail('CANCELLED', [row('READY_TO_SHIP')]), true, 'row is behind → must be fetched');
  // And the part that keeps it cheap: once written, it is never read again.
  assert.equal(orderNeedsDetail('CANCELLED', [row('CANCELLED')]), false);
});

test("a buyer's pending cancellation is always re-read", () => {
  // IN_CANCEL is a decision waiting on the seller and auto-approves when the
  // window closes, so it must never be treated as settled — not even when the
  // local row already agrees.
  assert.equal(orderNeedsDetail('IN_CANCEL', [row('IN_CANCEL')]), true);
  assert.equal(orderNeedsDetail('IN_CANCEL', []), true);
});
