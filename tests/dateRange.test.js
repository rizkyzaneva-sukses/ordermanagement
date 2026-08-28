'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BUSINESS_UTC_OFFSET = process.env.BUSINESS_UTC_OFFSET || '+07:00';
const { startOfDay, endOfDay, orderDateRange, businessToday, endOfBusinessToday } = require('../src/utils/dateRange.js');

test('a day runs from its first to its last instant in the business zone', () => {
  // 22 Aug 00:00 WIB is 21 Aug 17:00 UTC — the seven hours a UTC server would
  // have dropped from "hari ini".
  assert.equal(startOfDay('2026-08-22').toISOString(), '2026-08-21T17:00:00.000Z');
  assert.equal(endOfDay('2026-08-22').toISOString(), '2026-08-22T16:59:59.999Z');
});

test('a same-day range spans the whole day, not a single instant', () => {
  const range = orderDateRange('2026-08-22', '2026-08-22');
  const spanMs = range.lte - range.gte;
  assert.equal(spanMs, 24 * 60 * 60 * 1000 - 1);
});

test('an order at 03:00 WIB falls inside its own day', () => {
  const range = orderDateRange('2026-08-22', '2026-08-22');
  const earlyMorning = new Date('2026-08-22T03:00:00+07:00');
  assert.ok(earlyMorning >= range.gte && earlyMorning <= range.lte);
});

test('either bound may stand alone', () => {
  assert.deepEqual(Object.keys(orderDateRange('2026-08-22', undefined)), ['gte']);
  assert.deepEqual(Object.keys(orderDateRange(undefined, '2026-08-22')), ['lte']);
});

test('an hour cut-off is exclusive, matching the "s/d Pk 15:00" window', () => {
  // 14:59:59.999 WIB — the last instant before 15:00, so an order placed at
  // 15:00 sharp belongs to the next window rather than being counted twice.
  assert.equal(endOfDay('2026-08-22T15:00').toISOString(), '2026-08-22T07:59:59.999Z');
});

test('an hour on the lower bound starts exactly at that minute', () => {
  assert.equal(startOfDay('2026-08-22T09:30').toISOString(), '2026-08-22T02:30:00.000Z');
});

test('a bare day still spans the whole day once times are accepted', () => {
  assert.equal(endOfDay('2026-08-22').toISOString(), '2026-08-22T16:59:59.999Z');
});

test('a malformed date is ignored rather than becoming an Invalid Date', () => {
  assert.equal(orderDateRange('kemarin', ''), null);
  assert.equal(orderDateRange(undefined, undefined), null);
  // A full ISO timestamp is not what the picker sends, and silently reading it
  // as a day would move the boundary; refuse it instead.
  assert.equal(startOfDay('2026-08-22T10:00:00Z'), null);
  // Half a time is not a time.
  assert.equal(endOfDay('2026-08-22T15'), null);
});

test("today's boundary follows the seller's timezone, not the container's", () => {
  // The whole point of routing this through the business offset: a deployed
  // container has no TZ, so a server-local end-of-day would land at 07:00 WIB
  // and count tomorrow morning's deadlines as due today.
  const day = businessToday();
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(endOfBusinessToday().getTime(), endOfDay(day).getTime());
});

test("the business day rolls over at the seller's midnight", () => {
  // 23:59:59.999+07:00 is 16:59:59.999Z — the same edge the bare-day test above
  // asserts, now derived from the clock rather than a literal.
  const end = endOfBusinessToday();
  assert.equal(end.toISOString().slice(10), 'T16:59:59.999Z');
});
