'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  statusesFor,
  statusFilter,
  resolveTab,
  resolveSubTab,
  narrowStatuses,
} = require('../src/utils/orderTabs.js');

test('a tab constrains the list to its own statuses', () => {
  assert.deepEqual(statusesFor({ tab: 'unpaid' }), ['UNPAID']);
  assert.deepEqual(statusesFor({ tab: 'toShip' }), ['READY_TO_SHIP', 'RETRY_SHIP', 'PROCESSED']);
});

test('"Semua" constrains nothing', () => {
  assert.equal(statusesFor({ tab: 'all' }), null);
});

test('the sub-tab splits Perlu Dikirim by whether shipping was arranged', () => {
  assert.deepEqual(statusesFor({ tab: 'toShip', subTab: 'toProcess' }), ['READY_TO_SHIP', 'RETRY_SHIP']);
  assert.deepEqual(statusesFor({ tab: 'toShip', subTab: 'processed' }), ['PROCESSED']);
});

test('a sub-tab left over from Perlu Dikirim does not leak into another tab', () => {
  // Otherwise switching to Dikirim while "Telah Diproses" was selected would
  // filter by a control the operator can no longer see.
  assert.deepEqual(statusesFor({ tab: 'shipped', subTab: 'processed' }), ['SHIPPED', 'TO_CONFIRM_RECEIVE']);
});

test('the status dropdown narrows within the tab rather than overriding it', () => {
  assert.deepEqual(statusesFor({ tab: 'toShip', status: 'PROCESSED' }), ['PROCESSED']);
});

test('a status outside the tab yields nothing, not everything', () => {
  // The honest answer to "Belum Bayar orders that are SHIPPED" is none. Falling
  // back to no constraint would show the whole list instead.
  assert.deepEqual(statusesFor({ tab: 'unpaid', status: 'SHIPPED' }), []);
  assert.deepEqual(statusFilter([]), { in: [] });
});

test('an unknown tab falls back to the default instead of dropping the filter', () => {
  assert.equal(resolveTab('sudahDicetak'), 'toShip');
  assert.equal(resolveTab(undefined), 'toShip');
  assert.equal(resolveSubTab('nonsense'), 'all');
  assert.deepEqual(statusesFor({ tab: 'nonsense' }), ['READY_TO_SHIP', 'RETRY_SHIP', 'PROCESSED']);
});

test('statusFilter collapses a single status and leaves the rest to Prisma', () => {
  assert.equal(statusFilter(['UNPAID']), 'UNPAID');
  assert.deepEqual(statusFilter(['A', 'B']), { in: ['A', 'B'] });
  assert.equal(statusFilter(null), undefined);
});

test('narrowStatuses treats null as no constraint on either side', () => {
  assert.deepEqual(narrowStatuses(null, ['A']), ['A']);
  assert.deepEqual(narrowStatuses(['A', 'B'], null), ['A', 'B']);
  assert.deepEqual(narrowStatuses(['A', 'B'], ['B', 'C']), ['B']);
});
