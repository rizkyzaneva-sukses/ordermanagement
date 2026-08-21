'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPEE_PARTNER_ID = process.env.SHOPEE_PARTNER_ID || '1';
process.env.SHOPEE_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || 'test-key';

const shopee = require('../src/services/shopee.js');

/** _request narrates every attempt; keep the test output readable. */
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

/** Queue up canned responses; each fetch call shifts the next one off. */
const stubFetch = (responses) => {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('fetch called more times than the test queued');
    return {
      status: next.status,
      headers: { get: (h) => (next.headers || {})[h.toLowerCase()] ?? null },
      text: async () => next.body,
    };
  };
  return calls;
};

const ok = (payload = {}) => ({ status: 200, body: JSON.stringify({ ...payload }) });

test('a 5xx is retried and the later success is returned', quiet(async () => {
  const calls = stubFetch([
    { status: 503, body: '<html>Service Unavailable</html>' },
    ok({ response: { order_list: [] } }),
  ]);

  const data = await shopee._request('GET', '/api/v2/order/get_order_list', {}, null, 'tok', '123');

  assert.deepEqual(data.response.order_list, []);
  assert.equal(calls.length, 2, 'should have retried once');
}));

test('a 429 is retried rather than thrown', quiet(async () => {
  const calls = stubFetch([
    { status: 429, body: JSON.stringify({ error: 'error_rate_limit' }) },
    ok({ response: { more: false } }),
  ]);

  const data = await shopee._request('GET', '/api/v2/order/get_order_list', {}, null, 'tok', '123');

  assert.equal(data.response.more, false);
  assert.equal(calls.length, 2);
}));

test('Retry-After is honoured when Shopee sends one', quiet(async () => {
  stubFetch([
    { status: 429, body: '{}', headers: { 'retry-after': '1' } },
    ok({ response: {} }),
  ]);

  const t0 = Date.now();
  await shopee._request('GET', '/api/v2/order/get_order_list', {}, null, 'tok', '123');

  assert.ok(Date.now() - t0 >= 1000, 'should have waited the second Shopee asked for');
}));

test('transient failures that never clear surface as an error', quiet(async () => {
  const calls = stubFetch([
    { status: 500, body: 'boom' },
    { status: 500, body: 'boom' },
    { status: 500, body: 'boom' },
  ]);

  await assert.rejects(
    () => shopee._request('GET', '/api/v2/order/get_order_list', {}, null, 'tok', '123'),
    // The last attempt falls through to parsing, so the HTTP status has to be
    // in the message — that string is what the store row shows the operator.
    /HTTP 500/,
  );
  assert.equal(calls.length, 3, 'should have used every attempt');
}));

test('a non-retryable HTTP error is not retried', quiet(async () => {
  const calls = stubFetch([
    { status: 400, body: JSON.stringify({ error: 'error_param', message: 'order_status is invalid' }) },
  ]);

  await assert.rejects(
    () => shopee._request('GET', '/api/v2/order/get_order_list', {}, null, 'tok', '123'),
    /error_param/,
  );
  assert.equal(calls.length, 1);
}));

test('auth endpoints are never retried, even on a 5xx', quiet(async () => {
  // Retrying burns a single-use code or refresh token and forces the merchant
  // to reconnect by hand — worse than the transient failure itself.
  const calls = stubFetch([{ status: 503, body: 'gateway down' }]);

  await assert.rejects(
    () => shopee._request('POST', '/api/v2/auth/access_token/get', {}, {}, '', ''),
  );
  assert.equal(calls.length, 1, 'auth must stay single-attempt');
}));

// ── search_package_list request shape ────────────────────────────────────────
// Shopee rejected every call to this endpoint with "page_size must be 1 or
// greater" because pagination was sent at the top level. The error named a
// field the request did carry, which is why it read as transient rather than as
// the deterministic shape bug it was. These lock the shape down.

/** Capture the parsed body of the single request the call makes. */
const captureBody = (responseData = {}) => {
  const seen = {};
  global.fetch = async (url, opts) => {
    seen.url = String(url);
    seen.body = JSON.parse(opts.body);
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ response: responseData }),
    };
  };
  return seen;
};

test('page_size and cursor are nested under pagination, not top level', quiet(async () => {
  const seen = captureBody({ packages_list: [], pagination: { more: false } });

  await shopee.searchPackageList('tok', '123', { packageStatus: 0, pageSize: 50 });

  assert.equal(seen.body.pagination.page_size, 50);
  assert.equal(seen.body.pagination.cursor, '');
  assert.equal(seen.body.page_size, undefined, 'top-level page_size is what Shopee ignores');
  assert.equal(seen.body.cursor, undefined);
  assert.equal(seen.body.filter.package_status, 0);
  // The old code duplicated pagination onto the query string; it never helped.
  assert.ok(!seen.url.includes('page_size='), 'pagination does not belong on the query string');
}));

test('page_size is capped at this endpoint\'s limit of 50', quiet(async () => {
  const seen = captureBody({ packages_list: [], pagination: { more: false } });

  await shopee.searchPackageList('tok', '123', { pageSize: 100 });

  assert.equal(seen.body.pagination.page_size, 50);
}));

test('a logistics channel filter is sent as a plural array', quiet(async () => {
  const seen = captureBody({ packages_list: [], pagination: { more: false } });

  await shopee.searchPackageList('tok', '123', { logisticsChannelId: 80001 });

  assert.deepEqual(seen.body.filter.logistics_channel_ids, [80001]);
  assert.equal(seen.body.filter.logistics_channel_id, undefined);
}));

test('packages are read from packages_list with pagination one level down', quiet(async () => {
  stubFetch([
    ok({ response: {
      packages_list: [{ order_sn: 'A', package_number: 'P1' }],
      pagination: { more: true, next_cursor: 'c1' },
    } }),
    ok({ response: {
      packages_list: [{ order_sn: 'B', package_number: 'P2' }],
      pagination: { more: false },
    } }),
  ]);

  const all = await shopee.getAllPackages('tok', '123', 0);

  assert.deepEqual(all.map(p => p.package_number), ['P1', 'P2']);
}));

test('the older flat response shape is still understood', quiet(async () => {
  // Published schemas disagree on the plural; neither spelling may go silently
  // empty, because an empty list looks exactly like a shop with no packages.
  stubFetch([
    ok({ response: { package_list: [{ order_sn: 'A', package_number: 'P1' }], more: false } }),
  ]);

  const all = await shopee.getAllPackages('tok', '123', 0);

  assert.deepEqual(all.map(p => p.package_number), ['P1']);
}));

test('paging stops at the cap instead of following a cursor forever', quiet(async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ response: {
        packages_list: [{ order_sn: `A${calls}`, package_number: `P${calls}` }],
        pagination: { more: true, next_cursor: 'always-more' },
      } }),
    };
  };

  const all = await shopee.getAllPackages('tok', '123', 0, 3);

  assert.equal(calls, 3, 'must not page past the valve');
  assert.equal(all.length, 3);
}));
