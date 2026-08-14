'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { orderMerchandiseValue } = require('../src/services/orderValue.js');

/** Build a package row the way the sync writes one: items as a JSON string. */
const row = (items) => ({ items: JSON.stringify(items) });

const shopeeItem = (itemId, modelId, price, quantity) =>
  ({ itemId, modelId, price, quantity, name: `item-${itemId}` });

test('single package: price x quantity', () => {
  const order = [row([shopeeItem(1, 0, 50_000, 2)])];
  assert.equal(orderMerchandiseValue(order), 100_000);
});

test('single package: several lines add up', () => {
  const order = [row([
    shopeeItem(1, 0, 50_000, 2),
    shopeeItem(2, 9, 25_000, 1),
  ])];
  assert.equal(orderMerchandiseValue(order), 125_000);
});

test('single package: two identical lines are two real sales, not a duplicate', () => {
  // De-dup must not apply inside one package — TikTok in particular can repeat
  // a line, and collapsing it would undercount.
  const order = [row([
    { name: 'Kaos Polos', price: 30_000, quantity: 1 },
    { name: 'Kaos Polos', price: 30_000, quantity: 1 },
  ])];
  assert.equal(orderMerchandiseValue(order), 60_000);
});

test('split order: each package carries its own items, all counted', () => {
  const order = [
    row([shopeeItem(1, 100, 50_000, 1)]),
    row([shopeeItem(2, 200, 30_000, 2)]),
  ];
  assert.equal(orderMerchandiseValue(order), 110_000);
});

test('split order: sync fallback duplicated every item onto both rows, counted once', () => {
  // expandShopeeOrderToPackages falls back to the whole order's items when a
  // package has no item_list of its own. Summing rows blindly would double it.
  const items = [shopeeItem(1, 100, 50_000, 1), shopeeItem(2, 200, 30_000, 2)];
  const order = [row(items), row(items)];
  assert.equal(orderMerchandiseValue(order), 110_000);
});

test('split order across three packages: fallback duplication still counted once', () => {
  const items = [shopeeItem(1, 0, 17_500, 3)];
  const order = [row(items), row(items), row(items)];
  assert.equal(orderMerchandiseValue(order), 52_500);
});

test('same item id, different model, is not de-duplicated', () => {
  // KB §6 rule 4: a split separates item+model pairs, so both must count.
  const order = [
    row([shopeeItem(1, 100, 40_000, 1)]),
    row([shopeeItem(1, 200, 40_000, 1)]),
  ];
  assert.equal(orderMerchandiseValue(order), 80_000);
});

test('malformed items JSON is skipped, sound rows still count', () => {
  const order = [
    { items: '{not json' },
    row([shopeeItem(1, 0, 12_000, 1)]),
  ];
  assert.equal(orderMerchandiseValue(order), 12_000);
});

test('items already stored as an array is accepted', () => {
  // Older rows and the TikTok path have been seen holding an array.
  const order = [{ items: [shopeeItem(1, 0, 15_000, 2)] }];
  assert.equal(orderMerchandiseValue(order), 30_000);
});

test('missing quantity counts as one unit', () => {
  const order = [row([{ itemId: 1, modelId: 0, price: 45_000 }])];
  assert.equal(orderMerchandiseValue(order), 45_000);
});

test('missing or non-numeric price contributes nothing', () => {
  const order = [row([
    { itemId: 1, modelId: 0, quantity: 2 },
    { itemId: 2, modelId: 0, price: 'gratis', quantity: 1 },
    { itemId: 3, modelId: 0, price: 10_000, quantity: 1 },
  ])];
  assert.equal(orderMerchandiseValue(order), 10_000);
});

test('empty and absent inputs are zero, not a crash', () => {
  assert.equal(orderMerchandiseValue([]), 0);
  assert.equal(orderMerchandiseValue(null), 0);
  assert.equal(orderMerchandiseValue([{ items: '[]' }]), 0);
  assert.equal(orderMerchandiseValue([{ items: 'null' }]), 0);
  assert.equal(orderMerchandiseValue([{}]), 0);
});

test('junk entries inside the item list are ignored', () => {
  const order = [row([null, 'nope', shopeeItem(1, 0, 20_000, 1)])];
  assert.equal(orderMerchandiseValue(order), 20_000);
});
