'use strict';

/**
 * syncCheck.js — did this sync's own work actually agree with Shopee?
 *
 * The sync has always reported success or failure of the *request*. That is a
 * different question from whether the resulting data is right, and the gap
 * between the two is where every discrepancy this project has chased was
 * hiding: a status pass quietly failing, an order Shopee listed that never got
 * written, a row still claiming a status Shopee moved on from.
 *
 * Deliberately compares like with like: only orders Shopee actually mentioned
 * in this run are counted on both sides. Counting every local row against a
 * 15-day window would report a mismatch for every order that has simply aged
 * out, which is noise, and noise in a trust indicator is worse than no
 * indicator at all.
 *
 * Kept free of the database so the arithmetic can be tested directly — a wrong
 * number here would be reported as OrderPro's own data being wrong.
 */

/** Statuses an operator still has to do something about. */
const ACTIVE_STATUSES = new Set(['UNPAID', 'READY_TO_SHIP', 'RETRY_SHIP', 'PROCESSED', 'IN_CANCEL']);

/**
 * Compare what Shopee reported against what is stored.
 *
 * @param {Object} input
 * @param {Map<string, string|null>} input.shopeeStatuses - order_sn → status
 *   from the list passes. A null value means the order_sn was seeded by the
 *   package index without a status, so it says nothing about which status it
 *   belongs in and is excluded from the per-status tallies.
 * @param {Array<{orderId: string, status: string}>} input.localRows - One entry
 *   per local order (package rows already collapsed).
 * @param {string[]} [input.unanswered=[]] - Statuses whose pass failed this run.
 * @returns {Object}
 */
function buildSyncCheck({ shopeeStatuses, localRows, unanswered = [] }) {
  const localByOrderSn = new Map();
  for (const row of localRows) {
    if (!localByOrderSn.has(row.orderId)) localByOrderSn.set(row.orderId, row.status);
  }

  const shopee = new Map();
  const local = new Map();
  let missingLocally = 0;

  for (const [orderSn, status] of shopeeStatuses) {
    if (!status) continue;

    shopee.set(status, (shopee.get(status) || 0) + 1);

    const localStatus = localByOrderSn.get(orderSn);
    if (localStatus === undefined) {
      // Shopee named an order that has no row here at all.
      missingLocally++;
      continue;
    }
    local.set(localStatus, (local.get(localStatus) || 0) + 1);
  }

  // Rows we hold in a status that still needs work, which Shopee did not
  // mention this run. Usually means the order moved on and our row has not
  // caught up — the reconciliation pass exists to drain exactly these.
  let staleCandidates = 0;
  for (const [orderSn, status] of localByOrderSn) {
    if (!ACTIVE_STATUSES.has(status)) continue;
    if (!shopeeStatuses.has(orderSn)) staleCandidates++;
  }

  // Every local row by status, regardless of whether Shopee mentioned it. Only
  // used for statuses Shopee could not answer for: there is no Shopee set to
  // restrict against, so the honest figure is simply what we hold.
  const localAll = new Map();
  for (const status of localByOrderSn.values()) {
    localAll.set(status, (localAll.get(status) || 0) + 1);
  }

  // A failed pass has to appear as a row even though neither tally saw it —
  // its whole point is telling the operator that this status went unchecked.
  // Leaving it out would render an unverified status identically to a verified
  // one, which is the exact confusion this panel exists to remove.
  const allStatuses = [...new Set([...shopee.keys(), ...local.keys(), ...unanswered])].sort();

  const statuses = allStatuses.map((status) => {
    if (unanswered.includes(status)) {
      // Not zero. Shopee answered nothing, and a null says so.
      return { status, shopee: null, local: localAll.get(status) || 0, diff: null, unanswered: true };
    }
    const shopeeCount = shopee.get(status) || 0;
    const localCount = local.get(status) || 0;
    return {
      status,
      shopee: shopeeCount,
      local: localCount,
      // Reported rather than left to the reader to subtract, because this is
      // the number that decides whether anything is wrong.
      diff: localCount - shopeeCount,
      unanswered: false,
    };
  });

  const matched = statuses.every((s) => s.unanswered || s.diff === 0)
    && missingLocally === 0
    && unanswered.length === 0;

  return {
    at: new Date().toISOString(),
    matched,
    statuses,
    missingLocally,
    staleCandidates,
    unanswered,
  };
}

module.exports = { ACTIVE_STATUSES, buildSyncCheck };
