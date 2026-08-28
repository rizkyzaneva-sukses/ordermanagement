'use strict';

/**
 * Couriers that never collect from the seller — the parcel has to be taken to a
 * counter.
 *
 * This is not something Shopee tells us. `get_shipping_parameter` offers
 * `pickup` for these channels like any other, the shipment is arranged, and the
 * collection then simply never happens. The rule comes from the operators' own
 * handwriting on the Komplace process notes — "Pos dan JNE tidak bisa
 * dijemput" — and Komplace marks such orders "Pesanan tidak dapat dipickup".
 *
 * Matched on the courier name because that is what both Shopee and the
 * operators call it; the logistics channel id varies per shop and per service
 * tier, so a list of ids would go stale the first time a new JNE service is
 * enabled.
 */
const DROPOFF_ONLY_PATTERNS = [
  // Word boundaries matter: "Pos Reguler" and "Pos Kilat Khusus" are the target,
  // but a substring match would also catch names that merely contain "pos".
  /\bpos\b/i,
  /\bjne\b/i,
];

/**
 * Whether this courier requires dropping the parcel at a counter.
 *
 * @param {string|null|undefined} courierName
 * @returns {boolean}
 */
function isDropoffOnlyCourier(courierName) {
  if (!courierName) return false;
  return DROPOFF_ONLY_PATTERNS.some((re) => re.test(courierName));
}

/**
 * Shipping-mode preference for a courier, most desirable first.
 *
 * Only consulted when the operator did not choose a mode. Putting dropoff ahead
 * of pickup for these couriers is the whole point: the previous default picked
 * whichever mode Shopee listed first, which is pickup, and produced shipments
 * nobody would ever come to collect.
 *
 * @param {string|null|undefined} courierName
 * @returns {string[]}
 */
function modePreferenceFor(courierName) {
  return isDropoffOnlyCourier(courierName)
    ? ['dropoff', 'pickup', 'non_integrated']
    : ['pickup', 'dropoff', 'non_integrated'];
}

module.exports = { DROPOFF_ONLY_PATTERNS, isDropoffOnlyCourier, modePreferenceFor };
