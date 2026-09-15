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
 * One master SKU is one variation, grouped under a parent Master Produk per
 * item — the shape a Komplace screen recording showed on 14 Sep 2026. Bundles
 * (adrea+goldie) are deliberately not modelled, as in Komplace.
 */

/** Separator productSync puts between an item's name and its variation's. */
const NAME_SEPARATOR = ' — ';

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

/**
 * The item name a group of sibling listings (one Shopee item) share.
 *
 * Read from the stored column when the catalogue has been pulled since it
 * existed. Older rows only have the joined "Item — Variation" display name, so
 * the item half is recovered from what every sibling has in common, cut back to
 * a whole separator — "Belva Vest — Black" and "Belva Vest — Blue" share
 * "Belva Vest — Bl", and a parent called "Belva Vest — Bl" would be worse than
 * none.
 *
 * @param {Array<{name: string, itemName?: string|null, modelId?: string}>} siblings
 * @returns {string}
 */
function itemNameOf(siblings) {
  const stored = siblings.find(l => l.itemName)?.itemName;
  if (stored) return stored;
  if (siblings.length === 0) return '';

  const names = siblings.map(l => l.name || '');

  if (names.length === 1) {
    // A lone row without a model is the item itself. With a model, only the
    // last separator can be the one productSync added — item names carry their
    // own ("Zaneva Curve — Sidney Vest Outer").
    if (!siblings[0].modelId) return names[0];
    const cut = names[0].lastIndexOf(NAME_SEPARATOR);
    return cut > 0 ? names[0].slice(0, cut) : names[0];
  }

  let prefix = names[0];
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
  }

  // A variation Shopee sent without a name is stored under the bare item name,
  // so a prefix that is a whole name already is the item name — cutting it at
  // its last separator would chop the item's own.
  if (names.includes(prefix)) return prefix;

  const cut = prefix.lastIndexOf(NAME_SEPARATOR);
  return (cut > 0 ? prefix.slice(0, cut) : prefix).trim();
}

/**
 * The variation's own label ("Black"), or null for an item without variations.
 *
 * @param {{name: string, modelId?: string, modelName?: string|null}} listing
 * @param {string} itemName - From itemNameOf over the listing's siblings
 * @returns {string|null}
 */
function variantNameOf(listing, itemName) {
  if (!listing.modelId) return null;
  if (listing.modelName) return listing.modelName;
  const head = itemName + NAME_SEPARATOR;
  return itemName && listing.name.startsWith(head) ? listing.name.slice(head.length) : null;
}

/**
 * Validate one item's "Jadikan Master" form and decide what each row becomes.
 *
 * Mirrors Komplace: every variation of the item gets its own Master SKU, started
 * from the stock the listing already holds rather than from zero — the recording
 * showed Daftar Stok totalling exactly what Shopee held.
 *
 * All-or-nothing per item. A parent created with three of its five variations
 * because two SKUs were blank is a half-finished master nobody notices, so any
 * row problem fails the item and says which row.
 *
 * Each row resolves to one of:
 *   create  a new Master SKU under the new parent
 *   bind    the SKU already exists (typically the same item in another shop),
 *           so the listing joins that master instead of duplicating it
 *   skip    the listing is already mapped; a manual mapping is never re-pointed
 *
 * @param {{name: string, variants: Array<{listingId: string, masterSku: string}>}} input
 * @param {Map<string, {id: string, name: string, itemId: string, modelId: string,
 *   itemName?: string|null, modelName?: string|null, stock: number|null,
 *   productId: string|null}>} listingsById - Only listings the caller may act on
 * @param {Map<string, {id: string, masterSku: string}>} existingBySku - Keyed by normaliseSku
 * @returns {{ ok: true, name: string, creates: Array<Object>, binds: Array<Object>,
 *   skipped: Array<Object>, unreadStock: number } | { ok: false, errors: string[] }}
 */
function planMasterFromItem(input, listingsById, existingBySku) {
  const errors = [];
  const name = String(input?.name ?? '').trim();
  const rows = Array.isArray(input?.variants) ? input.variants : [];

  if (!name) errors.push('Nama master produk wajib diisi');
  if (rows.length === 0) errors.push('Tidak ada varian untuk dijadikan master');

  const listings = [];
  for (const row of rows) {
    const listing = listingsById.get(String(row.listingId));
    if (!listing) {
      errors.push(`Listing ${row.listingId} tidak ditemukan atau di luar toko yang bisa kamu akses`);
      continue;
    }
    listings.push({ listing, masterSku: String(row.masterSku ?? '').trim() });
  }

  if (new Set(listings.map(l => l.listing.itemId)).size > 1) {
    errors.push('Satu master produk hanya boleh berisi varian dari satu produk');
  }

  const itemName = itemNameOf(listings.map(l => l.listing));
  const seen = new Map();
  for (const { listing, masterSku } of listings) {
    if (listing.productId) continue;
    const label = variantNameOf(listing, itemName) || listing.name;
    const key = normaliseSku(masterSku);
    if (!key) {
      errors.push(`Master SKU untuk "${label}" masih kosong`);
      continue;
    }
    // Two variations on one SKU is the exact collapse this flow exists to stop,
    // and it happens quietly: a model without its own SKU inherits the item's.
    if (seen.has(key)) {
      errors.push(`Master SKU "${masterSku}" dipakai dua kali ("${seen.get(key)}" dan "${label}")`);
      continue;
    }
    seen.set(key, label);
  }

  if (errors.length > 0) return { ok: false, errors };

  const creates = [];
  const binds = [];
  const skipped = [];
  let unreadStock = 0;

  for (const { listing, masterSku } of listings) {
    if (listing.productId) {
      skipped.push({ listingId: listing.id, reason: 'sudah punya master' });
      continue;
    }
    const existing = existingBySku.get(normaliseSku(masterSku));
    if (existing) {
      binds.push({ listingId: listing.id, productId: existing.id, masterSku: existing.masterSku });
      continue;
    }
    // Unreadable is not zero, but a master needs a number; 0 is the safe one to
    // start from, and the count is reported so it gets checked on Daftar Stok.
    if (listing.stock === null || listing.stock === undefined) unreadStock++;
    creates.push({
      listingId: listing.id,
      masterSku,
      variantName: variantNameOf(listing, itemName),
      stock: Math.max(0, listing.stock ?? 0),
    });
  }

  return { ok: true, name, creates, binds, skipped, unreadStock };
}

module.exports = {
  normaliseSku,
  planAutoMap,
  planStockEdit,
  itemNameOf,
  variantNameOf,
  planMasterFromItem,
};
