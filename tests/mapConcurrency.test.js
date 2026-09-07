'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapWithConcurrency, CALL_CONCURRENCY } = require('../src/services/syncDirect.js');

/** Resolve after a tick, so several runners genuinely overlap. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('results come back in input order, not completion order', async () => {
  // Deliberately inverted delays: if the implementation collected results as
  // they finished, this would come back reversed — and a tracking number would
  // be written onto the wrong package.
  const items = [3, 2, 1];
  const out = await mapWithConcurrency(items, 3, async (n) => {
    for (let i = 0; i < n; i++) await tick();
    return n * 10;
  });
  assert.deepEqual(out, [30, 20, 10]);
});

test('every item is visited exactly once', async () => {
  const items = Array.from({ length: 57 }, (_, i) => i);
  const seen = [];
  const out = await mapWithConcurrency(items, 5, async (n) => {
    await tick();
    seen.push(n);
    return n;
  });
  assert.equal(out.length, 57);
  assert.deepEqual(out, items);
  assert.deepEqual([...seen].sort((a, b) => a - b), items);
});

test('never exceeds the concurrency limit', async () => {
  let inFlight = 0;
  let peak = 0;

  await mapWithConcurrency(Array.from({ length: 40 }, (_, i) => i), 5, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick();
    await tick();
    inFlight -= 1;
  });

  assert.equal(peak, 5, `expected at most 5 concurrent calls, saw ${peak}`);
});

test('a limit larger than the batch does not spawn idle runners', async () => {
  let peak = 0;
  let inFlight = 0;

  await mapWithConcurrency([1, 2], 10, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight -= 1;
    return n;
  });

  assert.equal(peak, 2);
});

test('an empty batch is a no-op rather than a hang', async () => {
  const out = await mapWithConcurrency([], CALL_CONCURRENCY, async () => {
    throw new Error('mapper must not run');
  });
  assert.deepEqual(out, []);
});

test('a rejecting mapper surfaces the error instead of silently dropping items', async () => {
  // The sync phases catch inside their own mapper; this pins down what happens
  // when one does not, so a future caller cannot assume failures are swallowed.
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/,
  );
});
