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
