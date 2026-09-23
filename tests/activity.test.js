'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ACTIONS, summariseBody, summariseResult } = require('../src/services/activity');

test('summariseBody drops secrets at any depth', () => {
  const out = summariseBody({ email: 'a@b.c', password: 'x', nested: { refreshToken: 'y', keep: 1 } });
  assert.deepStrictEqual(out, { email: 'a@b.c', nested: { keep: 1 } });
});

test('summariseBody cuts long lists to a count and the first 20', () => {
  const ids = Array.from({ length: 300 }, (_, i) => `o${i}`);
  const out = summariseBody({ orderIds: ids });
  assert.strictEqual(out.orderIds.count, 300);
  assert.strictEqual(out.orderIds.first.length, 20);
  assert.deepStrictEqual(summariseBody({ ids: ['a', 'b'] }), { ids: ['a', 'b'] });
});

test('summariseBody truncates long text', () => {
  const out = summariseBody({ text: 'x'.repeat(500) });
  assert.ok(out.text.length <= 201);
});

test('summariseResult keeps only counts from data', () => {
  assert.deepStrictEqual(
    summariseResult({ success: true, data: { deleted: 2, unmapped: 5, failed: [1, 2], master: { id: 'x' } } }),
    { deleted: 2, unmapped: 5, failed: 2 },
  );
  assert.strictEqual(summariseResult({ success: true, data: [1, 2] }), undefined);
  assert.strictEqual(summariseResult(undefined), undefined);
});

test('every action key is METHOD plus an /api path', () => {
  for (const key of Object.keys(ACTIONS)) {
    assert.match(key, /^(POST|PATCH|PUT|DELETE) \/api\//, key);
  }
});
