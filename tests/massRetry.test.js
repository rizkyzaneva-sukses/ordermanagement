'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { massRetryShipment } = require('../src/services/fulfillment.js');

/**
 * Only the validation that runs before any Shopee or database call is covered
 * here — everything past it needs a live shop. These are the checks that stop a
 * malformed bulk retry from reaching Shopee at all.
 */

const rejects = async (fn, status, match) => {
  await assert.rejects(fn, (err) => {
    assert.equal(err.statusCode, status, `expected ${status}, got ${err.statusCode}`);
    if (match) assert.match(err.message, match);
    return true;
  });
};

test('an empty selection is refused rather than sent as a no-op', async () => {
  await rejects(() => massRetryShipment([]), 400);
  await rejects(() => massRetryShipment([], { groups: [{ ids: [] }] }), 400);
});

test('a selection larger than one batch is refused before any Shopee call', async () => {
  // Each retry is its own update_shipping_order round trip, so an unbounded
  // batch would hold the request open long enough to time out mid-way.
  const ids = Array.from({ length: 51 }, (_, i) => `row-${i}`);
  await rejects(() => massRetryShipment(ids, {
    groups: [{ ids, addressId: 1, pickupTimeId: 'slot-1' }],
  }), 400, /At most 50/);
});

test('a courier without its own address and slot is refused', async () => {
  // Sending one courier's slot id with another's package is what Shopee
  // rejects as "Pickup time is out of range", so an incomplete group must not
  // silently inherit a neighbour's schedule.
  await rejects(() => massRetryShipment(['a'], {
    groups: [{ ids: ['a'], addressId: null, pickupTimeId: 'slot-1' }],
  }), 400, /alamat dan slot/);

  await rejects(() => massRetryShipment(['a'], {
    groups: [{ ids: ['a'], addressId: 5, pickupTimeId: '' }],
  }), 400, /alamat dan slot/);
});

test('a group carrying no orders does not block the ones that do', async () => {
  // An empty group is a courier the operator deselected, not a missing
  // schedule — demanding an address for it would refuse the whole run.
  await assert.rejects(
    () => massRetryShipment(['a'], {
      groups: [
        { ids: [], addressId: null, pickupTimeId: '' },
        { ids: ['a'], addressId: 5, pickupTimeId: 'slot-1' },
      ],
    }),
    // It gets past validation and fails later, reaching for an order that does
    // not exist. What matters is that it is not the schedule complaint.
    // Checked on the status code, not the text: Prisma quotes the surrounding
    // source in its own errors, so matching on the message would find the
    // validation string in a failure that never ran it.
    (err) => {
      assert.notEqual(err.statusCode, 400);
      return true;
    },
  );
});
