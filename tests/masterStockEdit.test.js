'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planStockEdit } = require('../src/services/productMapping.js');

const master = (id, stock) => ({ id, stock });

test('set writes the same number to every master, whatever it held', () => {
  const { writes, clamped } = planStockEdit(
    [master('a', 3), master('b', 400), master('c', 0)],
    'set',
    40,
  );

  assert.deepEqual(writes, [
    { id: 'a', stock: 40 },
    { id: 'b', stock: 40 },
    { id: 'c', stock: 40 },
  ]);
  assert.equal(clamped, 0);
});

test('adjust adds to each master separately, not to a shared total', () => {
  // The restock case: "30 more arrived" means 30 more of each, and a master that
  // held more still holds more afterwards.
  const { writes } = planStockEdit([master('a', 10), master('b', 100)], 'adjust', 30);

  assert.deepEqual(writes, [
    { id: 'a', stock: 40 },
    { id: 'b', stock: 130 },
  ]);
});

test('a subtraction that would go negative is floored and counted', () => {
  const { writes, clamped } = planStockEdit(
    [master('a', 20), master('b', 80)],
    'adjust',
    -50,
  );

  assert.deepEqual(writes, [
    { id: 'a', stock: 0 },
    { id: 'b', stock: 30 },
  ]);
  // The count is the whole point: a bulk edit touches every ticked SKU, so one
  // miscounted number is never just one.
  assert.equal(clamped, 1);
});

test('landing exactly on zero is not clamping', () => {
  const { writes, clamped } = planStockEdit([master('a', 50)], 'adjust', -50);

  assert.deepEqual(writes, [{ id: 'a', stock: 0 }]);
  assert.equal(clamped, 0);
});

test('set to zero is allowed and is not reported as clamped', () => {
  const { writes, clamped } = planStockEdit([master('a', 12)], 'set', 0);

  assert.deepEqual(writes, [{ id: 'a', stock: 0 }]);
  assert.equal(clamped, 0);
});

test('nothing selected plans no writes', () => {
  const { writes, clamped } = planStockEdit([], 'adjust', -5);
  assert.deepEqual(writes, []);
  assert.equal(clamped, 0);
});
