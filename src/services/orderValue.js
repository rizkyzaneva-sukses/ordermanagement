'use strict';

/**
 * orderValue.js — merchandise value of an order, derived from its item lines.
 *
 * There is no order-total column in the schema. The only money stored is
 * `price` and `quantity` inside each row's `items` JSON, so everything here is
 * an item subtotal: shipping fees, vouchers and platform discounts are not in
 * it, and neither is the settled payout (that lives behind the escrow API,
 * which this project does not call).
 *
 * Kept separate from the dashboard route so it can be tested without a database
 * — the de-duplication rule below is the part most likely to be wrong, and it
 * cannot be checked from the endpoint's output alone.
 */

/**
 * Stable identity for an item line.
 *
 * Shopee items carry an item/model pair. TikTok rows carry neither, so fall
 * back to the name and price — coarser, but only ever used as a de-dup key.
 */
function itemKey(item) {
  return item.itemId != null
    ? `${item.itemId}::${item.modelId ?? 0}`
    : `${item.name || ''}::${item.price ?? 0}`;
}

/**
 * Sum the merchandise value of one order across all of its package rows.
 *
 * De-duplication only kicks in for a multi-row (split) order. When Shopee
 * returns a package without its own `item_list`, the sync falls back to writing
 * the whole order's items onto every package row (see
 * expandShopeeOrderToPackages), so summing those rows blindly counts a split
 * order two or three times over. De-duplicating by item+model is safe there:
 * KB §6 rule 4 forbids splitting an identical item+model across packages, so a
 * genuine split never repeats a pair either.
 *
 * A single row is summed as-is. Nothing can be double-counted from one package,
 * and two identical line items within it are two real sales — collapsing them
 * would undercount.
 *
 * @param {Array<{items: string|Array}>} rows - Every package row of one order
 * @returns {number}
 */
function orderMerchandiseValue(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const dedupe = rows.length > 1;
  const seen = new Set();
  let total = 0;

  for (const row of rows) {
    let items = row?.items;

    if (typeof items === 'string') {
      try {
        items = JSON.parse(items || '[]');
      } catch {
        continue; // one malformed row must not take the whole panel down
      }
    }
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;

      if (dedupe) {
        const key = itemKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
      }

      const price = Number(item.price) || 0;
      // A line with no quantity is still one unit
      const quantity = Number(item.quantity) || 1;
      total += price * quantity;
    }
  }

  return total;
}

module.exports = { orderMerchandiseValue, itemKey };
