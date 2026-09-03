'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePartnerKeyExpiry } = require('../src/utils/expiry.js');

test("the console's own format is accepted verbatim", () => {
  // Exactly what Shopee Open Platform prints on the app detail page. Accepting
  // it removes the retyping step whose failure mode is silent.
  const parsed = parsePartnerKeyExpiry('26/01/27 22:59 (UTC+07:00)');
  assert.equal(parsed.label, '26 Januari 2027');
  assert.equal(parsed.date.toISOString(), '2027-01-26T15:59:00.000Z'); // 22:59 WIB
});

test('the plain ISO day is accepted too', () => {
  const parsed = parsePartnerKeyExpiry('2027-01-26');
  assert.equal(parsed.label, '26 Januari 2027');
  // No time given, so end of day — a key that lapses at 22:59 is usable most of
  // that day, and midnight would raise the alarm a day early.
  assert.equal(parsed.date.toISOString(), '2027-01-26T16:59:00.000Z');
});

test('the day comes first, as the console prints it', () => {
  // The whole reason for echoing the date back in words: read month-first,
  // 05/01/27 would be 1 May, and nothing on screen would betray it.
  assert.equal(parsePartnerKeyExpiry('05/01/27').label, '5 Januari 2027');
  assert.equal(parsePartnerKeyExpiry('01/05/27').label, '1 Mei 2027');
});

test('a four-digit year and a missing time still work', () => {
  assert.equal(parsePartnerKeyExpiry('26/01/2027').label, '26 Januari 2027');
  assert.equal(parsePartnerKeyExpiry('26/01/27').label, '26 Januari 2027');
});

test('a mistyped date is refused rather than rolled forward', () => {
  // JavaScript turns month 13 into January of the next year and 31 February
  // into early March — both would report a comfortable margin on a date that
  // was typed wrong.
  assert.equal(parsePartnerKeyExpiry('26/13/27'), null);
  assert.equal(parsePartnerKeyExpiry('31/02/27'), null);
  assert.equal(parsePartnerKeyExpiry('00/01/27'), null);
});

test('anything unreadable returns null instead of a guess', () => {
  assert.equal(parsePartnerKeyExpiry(''), null);
  assert.equal(parsePartnerKeyExpiry('   '), null);
  assert.equal(parsePartnerKeyExpiry('besok'), null);
  assert.equal(parsePartnerKeyExpiry(undefined), null);
  assert.equal(parsePartnerKeyExpiry(null), null);
});

test('the business timezone decides the instant', () => {
  const wib = parsePartnerKeyExpiry('26/01/27 22:59', '+07:00');
  const utc = parsePartnerKeyExpiry('26/01/27 22:59', '+00:00');
  assert.equal(utc.date.getTime() - wib.date.getTime(), 7 * 60 * 60 * 1000);
});
