'use strict';

/**
 * productMapping.js — master-side decisions that can be wrong without failing.
 *
 * Split out from the route because neither of these fails loudly when it is
 * wrong. A mapping bound to the wrong master shows a plausible SKU beside a
 * plausible product and only surfaces later, as stock moving on the wrong
 * listing; a bulk stock edit that floors at zero looks like it worked. Both are
 * pure here, so they can be exercised against the cases that matter without a
 * database or a live shop.
 *
 * One master is one SKU. Bundles (adrea+goldie) are deliberately not modelled —
 * PROSES KOMPLACE works the same way, and matching Komplace was the decision.
 */

/**
 * How a SKU is compared.
 *
 * Case and surrounding whitespace are typing noise, not meaning: an operator who
 * keyed "Aylee Set - Khaki" in one shop and "aylee set - khaki" in another meant
 * the same product both times. Anything beyond that — inner spacing, dashes,
 * punctuation — is left alone, because collapsing those starts matching SKUs
 * that a human would read as different products.
 *
 * @param {string|null|undefined} sku
 * @returns {string} The comparison key, empty if there is nothing to compare
 */
function normaliseSku(sku) {
  if (sku === null || sku === undefined) return '';
  return String(sku).trim().toLowerCase();
}

/**
 * Work out which unmapped listings can be bound to which masters by SKU alone.
 *
 * Only ever fills in blanks. A listing that already carries a `productId` is
 * never re-pointed however well its SKU matches something else — an operator's
 * manual decision outranks a string comparison, and silently overruling it would
 * undo their work every time this runs.
 *
 * @param {Array<{id: string, masterSku: string}>} masters
 * @param {Array<{id: string, sku: string|null, productId?: string|null}>} listings
 * @returns {{ plan: Map<string, string[]>, matched: number, skipped: number }}
 *   `plan` maps a master id to the listing ids to bind to it.
 */
function planAutoMap(masters, listings) {
  const bySku = new Map();
  for (const master of masters) {
    const key = normaliseSku(master.masterSku);
    // A blank master SKU would otherwise swallow every listing whose SKU is also
    // blank, which on this catalogue is hundreds of unrelated products.
    if (!key) continue;
    // First master wins. Two masters cannot share a SKU — the column is unique —
    // so this only fires when they differ by case, and picking either one
    // arbitrarily is better than binding the same listings to both.
    if (!bySku.has(key)) bySku.set(key, master.id);
  }

  const plan = new Map();
  let matched = 0;
  let skipped = 0;

  for (const listing of listings) {
    if (listing.productId) { skipped++; continue; }

    const key = normaliseSku(listing.sku);
    if (!key) { skipped++; continue; }

    const productId = bySku.get(key);
    if (!productId) { skipped++; continue; }

    if (!plan.has(productId)) plan.set(productId, []);
    plan.get(productId).push(listing.id);
    matched++;
  }

  return { plan, matched, skipped };
}

/**
 * Work out what each master's stock becomes under a bulk edit.
 *
 * Floors at zero and says how many rows it had to floor. Silently writing 0 for
 * an operator who subtracted 50 from a SKU holding 20 hides a counting mistake
 * exactly where it is cheapest to catch — a bulk edit touches every SKU they
 * ticked, so one wrong number is never one wrong number.
 *
 * @param {Array<{id: string, stock: number}>} masters
 * @param {'set'|'adjust'} mode
 * @param {number} amount - For 'adjust', negative subtracts
 * @returns {{ writes: Array<{id: string, stock: number}>, clamped: number }}
 */
function planStockEdit(masters, mode, amount) {
  const writes = [];
  let clamped = 0;

  for (const master of masters) {
    let next = mode === 'set' ? amount : master.stock + amount;
    if (next < 0) {
      clamped++;
      next = 0;
    }
    writes.push({ id: master.id, stock: next });
  }

  return { writes, clamped };
}

module.exports = {
  normaliseSku,
  planAutoMap,
  planStockEdit,
};
