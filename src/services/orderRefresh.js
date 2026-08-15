'use strict';

/**
 * orderRefresh.js — decides which discovered orders still need a detail read.
 *
 * `get_order_detail` used to be called for every order the list passes
 * returned, on every run. For a shop with thousands of orders that is hundreds
 * of calls every 15 minutes, most of them re-reading parcels that were already
 * delivered — and it is what Shopee's security team flagged as a surge in order
 * API calls.
 *
 * Kept separate from the sync so the decision can be tested without a database.
 * Skipping the wrong order means a row silently stops being refreshed, which is
 * the exact failure this project has already been bitten by.
 */

/**
 * Statuses where re-reading the detail teaches us nothing this app acts on.
 *
 * A parcel still moves through Shopee's states after it ships, but nothing here
 * changes as a result: it cannot be shipped, split, cancelled or labelled any
 * more. The next status change is picked up by the list passes, which report
 * `order_status` without costing a detail call.
 */
const SETTLED_STATUSES = new Set([
  'SHIPPED',
  'TO_CONFIRM_RECEIVE',
  'COMPLETED',
  'CANCELLED',
  'TO_RETURN',
]);

/**
 * Whether one order still warrants a `get_order_detail`.
 *
 * Biased towards fetching: an order is skipped only when Shopee and the
 * database already agree on a settled status. Any disagreement, any unknown,
 * and any missing tracking number earns a full read.
 *
 * @param {string|null|undefined} listStatus - order_status from the list passes
 * @param {Array<{status: string, trackingNumber: string|null}>} rows - Local package rows
 * @returns {boolean}
 */
function orderNeedsDetail(listStatus, rows) {
  // Seeded by search_package_list without a status — we know nothing yet
  if (!listStatus) return true;
  if (!SETTLED_STATUSES.has(listStatus)) return true;

  // Never seen locally, so there is nothing to compare against
  if (!Array.isArray(rows) || rows.length === 0) return true;

  // A split order has several rows; if any is behind, fetch the whole order
  return rows.some(row =>
    row.status !== listStatus ||
    // A shipped parcel with no tracking number is still missing the one field
    // that decides whether it can be printed
    (listStatus === 'SHIPPED' && !row.trackingNumber));
}

module.exports = { SETTLED_STATUSES, orderNeedsDetail };
