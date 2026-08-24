'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { groupRowsForShipping } = require('../src/services/fulfillment.js');

const row = (over) => ({
  id: 'row-1',
  storeId: 'shop-a',
  store: { name: 'Zaneva Official Shop' },
  shippingCourier: 'SiCepat Halu',
  logisticsChannelId: 100,
  ...over,
});

test('one courier stays one batch', () => {
  const groups = groupRowsForShipping([
    row({ id: 'a' }),
    row({ id: 'b' }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].orderRowIds, ['a', 'b']);
  assert.equal(groups[0].courier, 'SiCepat Halu');
  assert.equal(groups[0].storeName, 'Zaneva Official Shop');
});

test('couriers are split, because a pickup slot belongs to only one of them', () => {
  // The exact case Shopee rejected as "Pickup time is out of range": two
  // SiCepat and one SPX sent with a single slot id.
  const groups = groupRowsForShipping([
    row({ id: 'a' }),
    row({ id: 'b' }),
    row({ id: 'c', shippingCourier: 'SPX Standard', logisticsChannelId: 200 }),
  ]);
  assert.equal(groups.length, 2);
  const spx = groups.find((g) => g.courier === 'SPX Standard');
  assert.deepEqual(spx.orderRowIds, ['c']);
  assert.equal(spx.logisticsChannelId, 200);
});

test('the same courier in two shops is split, since the address is per shop', () => {
  const groups = groupRowsForShipping([
    row({ id: 'a' }),
    row({ id: 'b', storeId: 'shop-b', store: { name: 'Adrea Sportwear' } }),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.storeName).sort(), ['Adrea Sportwear', 'Zaneva Official Shop']);
});

test('rows without a logistics channel fall back to the courier name', () => {
  // Rows synced before that column existed, and orders Shopee never broke into
  // a package list, carry no channel id.
  const groups = groupRowsForShipping([
    row({ id: 'a', logisticsChannelId: null }),
    row({ id: 'b', logisticsChannelId: null }),
    row({ id: 'c', logisticsChannelId: null, shippingCourier: 'Pos Reguler' }),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((g) => g.courier === 'SiCepat Halu').orderRowIds, ['a', 'b']);
});

test('a channel id wins over the name, so a renamed service still batches as one', () => {
  const groups = groupRowsForShipping([
    row({ id: 'a', shippingCourier: 'SPX Standard' }),
    row({ id: 'b', shippingCourier: 'SPX Standard (Cashless)' }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].orderRowIds, ['a', 'b']);
});

test('a missing courier name does not collapse unrelated rows into one batch', () => {
  const groups = groupRowsForShipping([
    row({ id: 'a', shippingCourier: null, logisticsChannelId: 100 }),
    row({ id: 'b', shippingCourier: null, logisticsChannelId: 200 }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].courier, 'Tanpa kurir');
});
