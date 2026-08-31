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
 * How far along an order is, as a single ordered scale.
 *
 * Shopee describes the same order two different ways depending on which
 * question you ask. `get_order_list` answers with a coarse bucket; the detail
 * for that very order can come back finer. Real example from a live shop: 498
 * orders listed under SHIPPED, whose details were SHIPPED (494),
 * TO_CONFIRM_RECEIVE (3) and TO_RETURN (1). Nothing was wrong — the same
 * parcels, named two ways.
 *
 * Comparing those labels literally reported four missing orders that were never
 * missing, which is the failure this whole panel exists to avoid: an indicator
 * built for trust that cries wolf gets ignored, and then it may as well not
 * exist.
 *
 * IN_CANCEL sits deliberately between PROCESSED and SHIPPED. It is not a stage
 * of its own so much as a request laid over whatever stage the order had
 * reached, and Shopee keeps listing such an order under its fulfilment status —
 * which is why "Minta Batal +1 / Sudah Diatur −1" appeared on three shops at
 * once, always summing to zero.
 */
const STAGE = {
  UNPAID:             0,
  READY_TO_SHIP:      1,
  RETRY_SHIP:         1,
  PROCESSED:          2,
  IN_CANCEL:          2.5,
  SHIPPED:            3,
  TO_CONFIRM_RECEIVE: 3,
  TO_RETURN:          3,
  COMPLETED:          4,
  CANCELLED:          5,
};

/**
 * Is what we hold consistent with the bucket Shopee listed the order in?
 *
 * Only being *behind* counts as a disagreement. Holding a status further along
 * than the list said is not an error: the list is a snapshot taken at the start
 * of the run, and the detail read that followed is by definition newer. Warning
 * about our own data being more current would be noise.
 *
 * An unknown status on either side is treated as a disagreement rather than
 * waved through — a status nobody here has seen before is exactly the thing
 * worth looking at.
 */
function isConsistent(listStatus, localStatus) {
  if (listStatus === localStatus) return true;

  const listStage = STAGE[listStatus];
  const localStage = STAGE[localStatus];
  if (listStage === undefined || localStage === undefined) return false;

  return localStage >= listStage;
}

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
  const agreed = new Map();
  // Which local statuses the disagreeing orders are sitting in, per bucket —
  // "1 beda" is a fact, "1 tercatat Minta Batal" is something to act on.
  const behind = new Map();
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

    if (isConsistent(status, localStatus)) {
      agreed.set(status, (agreed.get(status) || 0) + 1);
    } else {
      if (!behind.has(status)) behind.set(status, new Map());
      const perLocal = behind.get(status);
      perLocal.set(localStatus, (perLocal.get(localStatus) || 0) + 1);
    }
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
  const allStatuses = [...new Set([...shopee.keys(), ...unanswered])].sort();

  const statuses = allStatuses.map((status) => {
    if (unanswered.includes(status)) {
      // Not zero. Shopee answered nothing, and a null says so.
      return { status, shopee: null, agreed: 0, behind: 0, behindStatuses: {}, local: localAll.get(status) || 0, unanswered: true };
    }
    const perLocal = behind.get(status) || new Map();
    const behindCount = [...perLocal.values()].reduce((n, c) => n + c, 0);
    return {
      status,
      shopee: shopee.get(status) || 0,
      agreed: agreed.get(status) || 0,
      behind: behindCount,
      behindStatuses: Object.fromEntries(perLocal),
      unanswered: false,
    };
  });

  const matched = statuses.every((s) => s.unanswered || s.behind === 0)
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

module.exports = { ACTIVE_STATUSES, STAGE, isConsistent, buildSyncCheck };
