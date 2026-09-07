'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPEE_PARTNER_ID = process.env.SHOPEE_PARTNER_ID || '1';
process.env.SHOPEE_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || 'test-key';

const shopee = require('../src/services/shopee.js');

/** The client narrates every call; keep the test output readable. */
const quiet = (fn) => async (t) => {
  const realError = console.error;
  const realFetch = global.fetch;
  console.error = () => {};
  try {
    await fn(t);
  } finally {
    console.error = realError;
    global.fetch = realFetch;
  }
};

/** Queue canned responses; each fetch shifts the next one off. */
const stubFetch = (responses) => {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('fetch called more times than the test queued');
    return {
      status: next.status,
      headers: { get: () => null },
      text: async () => next.body,
    };
  };
  return calls;
};

const ok = (payload) => ({ status: 200, body: JSON.stringify(payload) });

test('a multi-value parameter becomes repeated keys, not a joined string', quiet(async () => {
  // Shopee answers "item_status is invalid" to item_status=NORMAL,UNLIST, and
  // `String(['NORMAL','UNLIST'])` produces exactly that — a failure that reads
  // like a permissions problem rather than a serialization bug.
  const calls = stubFetch([ok({ response: { item: [], has_next_page: false } })]);

  await shopee.getItemList('token', 123, { itemStatus: ['NORMAL', 'UNLIST'] });

  const params = new URL(calls[0]).searchParams;
  assert.deepEqual(params.getAll('item_status'), ['NORMAL', 'UNLIST']);
  assert.ok(!calls[0].includes('NORMAL%2CUNLIST'), 'must not comma-join the statuses');
}));

test('a single scalar parameter is still sent once, unchanged', quiet(async () => {
  const calls = stubFetch([ok({ response: { tier_variation: [], model: [] } })]);

  await shopee.getModelList('token', 123, 99887766);

  const params = new URL(calls[0]).searchParams;
  assert.equal(params.get('item_id'), '99887766');
}));

test('lists Shopee wants joined are still joined by the caller', quiet(async () => {
  // item_id_list is the opposite convention to item_status: one comma-separated
  // value. Pinned here so a future change to the array handling cannot quietly
  // turn it into repeated keys.
  const calls = stubFetch([ok({ response: { item_list: [] } })]);

  await shopee.getItemBaseInfo('token', 123, [111, 222, 333]);

  const params = new URL(calls[0]).searchParams;
  assert.equal(params.get('item_id_list'), '111,222,333');
  assert.equal(params.getAll('item_id_list').length, 1);
}));

test('getItemBaseInfo refuses more than Shopee will accept', async () => {
  await assert.rejects(
    shopee.getItemBaseInfo('token', 123, new Array(51).fill(1)),
    /maximum of 50/,
  );
  await assert.rejects(shopee.getItemBaseInfo('token', 123, []), /non-empty/);
});

test('getAllItems follows next_offset to the end', quiet(async () => {
  stubFetch([
    ok({ response: { item: [{ item_id: 1 }, { item_id: 2 }], has_next_page: true, next_offset: 2 } }),
    ok({ response: { item: [{ item_id: 3 }], has_next_page: false } }),
  ]);

  const items = await shopee.getAllItems('token', 123);
  assert.deepEqual(items.map(i => i.item_id), [1, 2, 3]);
}));

test('paging stops rather than looping when the offset stops advancing', quiet(async () => {
  // A next_offset that never moves would otherwise spin until the page cap,
  // re-fetching the same rows and inflating the catalogue with duplicates.
  stubFetch([
    ok({ response: { item: [{ item_id: 1 }], has_next_page: true, next_offset: 0 } }),
  ]);

  const items = await shopee.getAllItems('token', 123);
  assert.deepEqual(items.map(i => i.item_id), [1]);
}));
