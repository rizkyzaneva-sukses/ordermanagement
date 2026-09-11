'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseSku, planAutoMap } = require('../src/services/productMapping.js');

const master = (id, masterSku) => ({ id, masterSku });
const listing = (id, sku, productId = null) => ({ id, sku, productId });

test('a SKU matches across shops regardless of case and padding', () => {
  const { plan, matched } = planAutoMap(
    [master('m1', 'Aylee Set - Khaki')],
    [
      listing('l1', 'Aylee Set - Khaki'),
      listing('l2', 'aylee set - khaki'),
      listing('l3', '  Aylee Set - Khaki  '),
    ],
  );

  assert.equal(matched, 3);
  assert.deepEqual(plan.get('m1'), ['l1', 'l2', 'l3']);
});

test('inner spacing is left alone — those read as different products', () => {
  // "Aylee Set-Khaki" is not obviously the same SKU as "Aylee Set - Khaki", and
  // guessing that it is binds stock to the wrong listing.
  const { matched, skipped } = planAutoMap(
    [master('m1', 'Aylee Set - Khaki')],
    [listing('l1', 'Aylee Set-Khaki')],
  );

  assert.equal(matched, 0);
  assert.equal(skipped, 1);
});

test('a listing an operator already mapped is never re-pointed', () => {
  // The whole risk of running this repeatedly: a manual decision must outrank a
  // string comparison, or every run undoes the operator's corrections.
  const { plan, matched, skipped } = planAutoMap(
    [master('m1', 'Zora')],
    [listing('l1', 'Zora', 'm-other')],
  );

  assert.equal(matched, 0);
  assert.equal(skipped, 1);
  assert.equal(plan.size, 0);
});

test('a blank master SKU swallows nothing', () => {
  // Hundreds of listings on this catalogue have no seller SKU. A master with an
  // empty SKU matching all of them would be a catastrophe that looks like success.
  const { matched, skipped } = planAutoMap(
    [master('m1', '   ')],
    [listing('l1', null), listing('l2', ''), listing('l3', '   ')],
  );

  assert.equal(matched, 0);
  assert.equal(skipped, 3);
});

test('listings are grouped per master, and every match lands in exactly one', () => {
  const { plan, matched } = planAutoMap(
    [master('m1', 'Zora'), master('m2', 'Goldie')],
    [
      listing('l1', 'Zora'),
      listing('l2', 'Goldie'),
      listing('l3', 'zora'),
      listing('l4', 'Adrea'),
    ],
  );

  assert.equal(matched, 3);
  assert.deepEqual(plan.get('m1'), ['l1', 'l3']);
  assert.deepEqual(plan.get('m2'), ['l2']);

  const everyId = [...plan.values()].flat();
  assert.equal(new Set(everyId).size, everyId.length);
});

test('two masters differing only by case do not both claim the same listings', () => {
  const { plan, matched } = planAutoMap(
    [master('m1', 'Zora'), master('m2', 'ZORA')],
    [listing('l1', 'zora')],
  );

  assert.equal(matched, 1);
  assert.equal(plan.size, 1);
  assert.deepEqual(plan.get('m1'), ['l1']);
});

test('nothing to map is not an error', () => {
  const { plan, matched, skipped } = planAutoMap([], [listing('l1', 'Zora')]);
  assert.equal(plan.size, 0);
  assert.equal(matched, 0);
  assert.equal(skipped, 1);
});

test('normaliseSku tolerates the absent SKU the schema allows', () => {
  assert.equal(normaliseSku(null), '');
  assert.equal(normaliseSku(undefined), '');
  assert.equal(normaliseSku('  Zora  '), 'zora');
});
