'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { summariseItems, planBoost, readBoostResult } = require('../src/services/productBoost.js');

const at = (iso) => new Date(iso);

test('variations add up to one item, unknown stock stays unknown', () => {
  const items = summariseItems([
    { itemId: '1', itemName: 'Belva Vest', stock: 3 },
    { itemId: '1', itemName: 'Belva Vest', stock: 0 },
    { itemId: '2', name: 'Zora Cap', stock: null },
  ]);
  assert.equal(items.get('1').stock, 3);
  assert.equal(items.get('1').name, 'Belva Vest');
  assert.equal(items.get('2').stock, null);
});

test('never-tried items go first, then the one tried longest ago', () => {
  const pick = planBoost({
    activeItemIds: ['a', 'b', 'c', 'd'],
    items: new Map(),
    boostedIds: new Set(),
    lastTried: new Map([['a', at('2026-10-30T08:00Z')], ['b', at('2026-10-29T08:00Z')]]),
    slots: 3,
  });
  assert.deepEqual(pick, ['c', 'd', 'b']);
});

test('boosted and sold-out items are skipped; unknown stock is eligible', () => {
  const pick = planBoost({
    activeItemIds: ['a', 'b', 'c', 'a'],
    items: new Map([['b', { stock: 0 }], ['c', { stock: null }]]),
    boostedIds: new Set(['a']),
    lastTried: new Map(),
    slots: 5,
  });
  assert.deepEqual(pick, ['c']);
});

test('no free slot means nothing is picked', () => {
  assert.deepEqual(planBoost({
    activeItemIds: ['a'], items: new Map(), boostedIds: new Set(), lastTried: new Map(), slots: 0,
  }), []);
});

test('an item Shopee did not answer for counts as failed', () => {
  const { ok, failed } = readBoostResult(['1', '2', '3'], {
    success_list: { item_id_list: [1] },
    failure_list: [{ item_id: 2, failed_reason: 'item is not normal' }],
  });
  assert.deepEqual(ok, ['1']);
  assert.deepEqual(failed.map(f => f.itemId), ['2', '3']);
  assert.equal(failed[0].reason, 'item is not normal');
});
