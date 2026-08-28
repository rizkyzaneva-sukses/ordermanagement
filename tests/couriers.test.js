'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDropoffOnlyCourier, modePreferenceFor } = require('../src/utils/couriers.js');

test('Pos and JNE services are recognised whatever the tier is called', () => {
  for (const name of ['Pos Reguler', 'POS Kilat Khusus', 'Pos Indonesia', 'JNE', 'JNE REG', 'JNE YES', 'jne oke']) {
    assert.equal(isDropoffOnlyCourier(name), true, name);
  }
});

test('couriers that do collect are left alone', () => {
  for (const name of ['SPX Hemat', 'SPX Standard', 'SiCepat Halu', 'Anteraja', 'J&T Express', 'Ninja Xpress']) {
    assert.equal(isDropoffOnlyCourier(name), false, name);
  }
});

test('a missing courier name is not treated as dropoff-only', () => {
  // Rows synced before the column existed have none, and defaulting them to
  // "antar ke counter" would quietly change how they are shipped.
  assert.equal(isDropoffOnlyCourier(null), false);
  assert.equal(isDropoffOnlyCourier(undefined), false);
  assert.equal(isDropoffOnlyCourier(''), false);
});

test('the name must be the courier, not merely contain the letters', () => {
  assert.equal(isDropoffOnlyCourier('Deposito Express'), false);
  assert.equal(isDropoffOnlyCourier('Positive Logistics'), false);
});

test('dropoff leads the preference only for couriers that cannot collect', () => {
  assert.deepEqual(modePreferenceFor('Pos Reguler'), ['dropoff', 'pickup', 'non_integrated']);
  assert.deepEqual(modePreferenceFor('SPX Hemat'), ['pickup', 'dropoff', 'non_integrated']);
});
