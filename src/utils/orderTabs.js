'use strict';

/**
 * The order list's tabs, expressed in marketplace statuses.
 *
 * Deliberately the same shape Seller Centre and Komplace use, because these are
 * the only counts that can be checked against Shopee. A tab keyed on something
 * we invent — "sudah dicetak", say — has no counterpart there, so a mismatch
 * could never be resolved; that one is a secondary filter instead.
 *
 * Selesai / Pembatalan / Retur are absent on purpose: sync only fetches four
 * statuses within a 15-day window, so those totals would be wrong in a way the
 * operator notices immediately. They stay reachable through the status
 * dropdown until a historical backfill makes honest tabs possible.
 */
const ORDER_TABS = {
  all:     null,   // no status constraint
  unpaid:  ['UNPAID'],
  toShip:  ['READY_TO_SHIP', 'RETRY_SHIP', 'PROCESSED'],
  shipped: ['SHIPPED', 'TO_CONFIRM_RECEIVE'],
};

/**
 * Sub-tabs inside "Perlu Dikirim", split by whether ship_order has run.
 *
 * The distinction drives what the operator does next: `toProcess` needs a
 * shipment arranged, `processed` already has one and is waiting to be printed.
 */
const ORDER_SUB_TABS = {
  all:       null,
  toProcess: ['READY_TO_SHIP', 'RETRY_SHIP'],
  processed: ['PROCESSED'],
};

const DEFAULT_TAB = 'toShip';
const DEFAULT_SUB_TAB = 'all';

/**
 * Intersect two status lists, treating null as "no constraint".
 *
 * @param {string[]|null} current
 * @param {string[]|null} next
 * @returns {string[]|null}
 */
function narrowStatuses(current, next) {
  if (!next) return current;
  if (!current) return next;
  return current.filter((s) => next.includes(s));
}

/** Fall back to the default rather than trusting a query string. */
function resolveTab(tab) {
  return Object.prototype.hasOwnProperty.call(ORDER_TABS, tab) ? tab : DEFAULT_TAB;
}

function resolveSubTab(subTab) {
  return Object.prototype.hasOwnProperty.call(ORDER_SUB_TABS, subTab) ? subTab : DEFAULT_SUB_TAB;
}

/**
 * The statuses a request should be limited to.
 *
 * Tab, then sub-tab, then the explicit dropdown — each narrows the one before
 * it, so a dropdown value outside the current tab yields nothing rather than
 * quietly overriding the tab the operator is looking at. Sub-tabs apply only
 * inside `toShip`; elsewhere they are not shown, and honouring a stale one
 * would filter the list by something invisible.
 *
 * @param {Object} opts
 * @param {string} [opts.tab]
 * @param {string} [opts.subTab]
 * @param {string} [opts.status] - explicit dropdown value
 * @returns {string[]|null} null when nothing constrains the status
 */
function statusesFor({ tab, subTab, status } = {}) {
  const activeTab = resolveTab(tab);
  let statuses = ORDER_TABS[activeTab];

  if (activeTab === 'toShip') {
    statuses = narrowStatuses(statuses, ORDER_SUB_TABS[resolveSubTab(subTab)]);
  }
  if (status) {
    statuses = narrowStatuses(statuses, [status]);
  }
  return statuses;
}

/**
 * Prisma `where.status` value for a status list, or undefined when unconstrained.
 *
 * An empty list is a real answer, not an absent one: it means the dropdown and
 * the tab disagree, and the honest result is no rows. Returning undefined there
 * would silently widen the query to everything.
 */
function statusFilter(statuses) {
  if (!statuses) return undefined;
  if (statuses.length === 1) return statuses[0];
  return { in: statuses };
}

module.exports = {
  ORDER_TABS,
  ORDER_SUB_TABS,
  DEFAULT_TAB,
  DEFAULT_SUB_TAB,
  narrowStatuses,
  resolveTab,
  resolveSubTab,
  statusesFor,
  statusFilter,
};
