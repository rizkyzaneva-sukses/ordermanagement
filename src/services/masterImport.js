'use strict';

/**
 * masterImport.js — Import Master and Import Stok from an operator's .xlsx.
 *
 * The operator asked on 24 Oct 2026 to stop making masters one product at a
 * time (PRD-import-xlsx.md). The file is the template OrderPro hands out, edited
 * in Excel and uploaded back; nothing here reads a workbook — importWorkbook.js
 * turns one into rows of text first, so every decision below can be exercised
 * without a file, a database or a shop.
 *
 * Both imports are previewed before they save, and the save runs the same plan
 * again on fresh data rather than trusting what the preview said.
 */

const { normaliseSku, variantNameOf } = require('./productMapping');

/** Rows one file may carry. The catalogue is ~1.335 items across 14 shops. */
const MAX_ROWS = 20000;

/**
 * Columns of the Import Master template, in the order they are written.
 * `edit` marks what the operator is meant to change; the rest are context.
 */
const MASTER_COLUMNS = [
  { key: 'store', header: 'Toko', width: 22 },
  { key: 'product', header: 'Nama Produk', width: 42 },
  { key: 'variant', header: 'Varian', width: 20 },
  { key: 'sku', header: 'SKU Shopee', width: 22, text: true },
  { key: 'listingStock', header: 'Stok Shopee', width: 12 },
  { key: 'masterSku', header: 'Master SKU', width: 24, text: true, edit: true },
  { key: 'masterName', header: 'Nama Master Produk', width: 42, edit: true },
  { key: 'startStock', header: 'Stok Awal', width: 12, edit: true },
  { key: 'listingId', header: 'ID (jangan diubah)', width: 30, text: true, locked: true },
];
const MASTER_REQUIRED = ['listingId', 'masterSku'];

/** Columns of the Export Stok file. */
const STOCK_COLUMNS = [
  { key: 'masterSku', header: 'Master SKU', width: 24, text: true, locked: true },
  { key: 'masterName', header: 'Nama Master Produk', width: 42 },
  { key: 'variant', header: 'Varian', width: 20 },
  { key: 'bound', header: 'Varian Terikat', width: 14 },
  { key: 'currentStock', header: 'Stok Sekarang', width: 14 },
  { key: 'newStock', header: 'Stok Baru', width: 12, edit: true },
];
const STOCK_REQUIRED = ['masterSku', 'newStock'];

/**
 * How a header cell is compared: case, spacing and anything in brackets are
 * ignored, so "ID (jangan diubah)" and "id" are one column and a header the
 * operator retyped as "master sku" still counts.
 */
function headerKey(text) {
  return String(text ?? '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * A stock cell as typed: a whole number of at least zero, or blank.
 *
 * Stricter than Number(): "1.200" is a thousand-separated 1200 to an Indonesian
 * operator and 1.2 to JavaScript, and guessing either way writes a wrong stock
 * to every shop. Anything but plain digits is refused and the row is named.
 *
 * @returns {{ value: number|null } | { error: string }}
 */
function parseStockCell(text) {
  const s = String(text ?? '').trim();
  if (!s) return { value: null };
  if (!/^\d+$/.test(s)) return { error: `"${s}" bukan angka bulat (tulis tanpa titik, koma, atau minus)` };
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return { error: `"${s}" terlalu besar` };
  return { value: n };
}

/**
 * Turn a sheet's text into rows keyed by column.
 *
 * The header is the first row; columns are found by name, not position, so an
 * operator who hid or reordered a column has not broken the file. Blank rows
 * are dropped. A file without the columns an import needs is refused outright —
 * it is almost always the wrong file, and row-by-row errors would bury that.
 *
 * @param {Array<{row: number, cells: string[]}>} matrix - From importWorkbook.readSheet
 * @param {Array<{key: string, header: string}>} columns
 * @param {string[]} required - Keys that must be present
 * @returns {{ rows: Array<Object>, error?: string }} Each row carries `row`, its
 *   Excel row number, plus one string per known column.
 */
function readRows(matrix, columns, required) {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    return { rows: [], error: 'File kosong. Pakai file dari tombol unduh di OrderPro.' };
  }

  const [head, ...body] = matrix;
  const indexOf = new Map();
  head.cells.forEach((cell, i) => {
    const col = columns.find(c => headerKey(c.header) === headerKey(cell));
    if (col && !indexOf.has(col.key)) indexOf.set(col.key, i);
  });

  const missing = required.filter(k => !indexOf.has(k));
  if (missing.length > 0) {
    const names = missing.map(k => `"${columns.find(c => c.key === k).header}"`).join(', ');
    return { rows: [], error: `Kolom ${names} tidak ditemukan di baris pertama. Pakai file dari tombol unduh di OrderPro.` };
  }

  const rows = [];
  for (const { row, cells } of body) {
    if (cells.every(c => String(c ?? '').trim() === '')) continue;
    const out = { row };
    for (const [key, i] of indexOf) out[key] = String(cells[i] ?? '').trim();
    rows.push(out);
  }

  if (rows.length > MAX_ROWS) {
    return { rows: [], error: `File berisi ${rows.length} baris, maksimal ${MAX_ROWS}. Pecah per toko.` };
  }
  return { rows };
}

/**
 * Decide what an Import Master file does, without doing it.
 *
 * Rows sharing a Master SKU become one master, whichever shop they come from —
 * that is the point of a master. Within one Shopee item, though, two variations
 * on one SKU are refused unless `shareSku` says it is meant: the same rule, and
 * the same reason, as the Jadikan Master form (planMasterFromItem).
 *
 * Never touches what is already decided. A listing with a master is skipped
 * however its row is filled in, and a Master SKU that already exists only gains
 * listings — its stock is the operator's last count, not the file's.
 *
 * A new master's stock is the Stok Awal typed for it, or else the smallest stock
 * among its listings: shops that disagree mean some of that stock is not there,
 * and starting low is cheaper than overselling (PRD decision A).
 *
 * @param {Array<{row: number, listingId?: string, masterSku?: string,
 *   masterName?: string, startStock?: string}>} rows - From readRows
 * @param {Map<string, {id: string, storeId: string, itemId: string, modelId: string,
 *   name: string, itemName?: string|null, modelName?: string|null,
 *   stock: number|null, productId: string|null}>} listingsById - Only listings
 *   the caller may act on
 * @param {Map<string, {id: string, masterSku: string, stock: number}>} existingBySku - Keyed by normaliseSku
 * @param {{ shareSku?: boolean }} [options]
 */
function planMasterImport(rows, listingsById, existingBySku, options = {}) {
  const shareSku = options.shareSku === true;
  const errors = [];
  const warnings = [];
  const skipped = [];
  const accepted = [];
  const rowOfListing = new Map();

  for (const r of rows) {
    const id = String(r.listingId ?? '').trim();
    const masterSku = String(r.masterSku ?? '').trim();

    if (!id) {
      if (masterSku) errors.push({ row: r.row, message: 'Kolom ID kosong, jadi baris ini tidak bisa dicocokkan ke listing' });
      else skipped.push({ row: r.row, reason: 'Master SKU kosong' });
      continue;
    }
    if (rowOfListing.has(id)) {
      errors.push({ row: r.row, message: `Listing yang sama sudah ada di baris ${rowOfListing.get(id)}` });
      continue;
    }
    rowOfListing.set(id, r.row);

    const listing = listingsById.get(id);
    if (!listing) {
      errors.push({ row: r.row, message: 'ID tidak dikenal, atau listing ini di toko yang tidak bisa kamu akses' });
      continue;
    }
    if (!masterSku) { skipped.push({ row: r.row, reason: 'Master SKU kosong' }); continue; }
    if (listing.productId) { skipped.push({ row: r.row, reason: 'Sudah punya master' }); continue; }

    const stock = parseStockCell(r.startStock);
    if (stock.error) { errors.push({ row: r.row, message: `Stok Awal ${stock.error}` }); continue; }

    accepted.push({
      row: r.row,
      listing,
      masterSku,
      masterName: String(r.masterName ?? '').trim(),
      startStock: stock.value,
    });
  }

  const groups = new Map();
  for (const a of accepted) {
    const key = normaliseSku(a.masterSku);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  const parents = new Map();
  const binds = [];
  const pushIds = new Set();
  let sharedConflicts = 0;
  let unreadStock = 0;

  for (const [key, group] of groups) {
    const existing = existingBySku.get(key);
    if (existing) {
      for (const a of group) {
        binds.push({ row: a.row, listingId: a.listing.id, productId: existing.id, masterSku: existing.masterSku });
        if (a.startStock !== null) {
          warnings.push({ row: a.row, message: `Stok Awal diabaikan: Master SKU "${existing.masterSku}" sudah ada, stoknya tidak diubah` });
        }
        if (a.listing.stock !== existing.stock) pushIds.add(existing.id);
      }
      continue;
    }

    // Two variations of one item on one SKU: usually a model that inherited the
    // item's SKU, which would quietly give every colour one stock figure.
    const firstInItem = new Map();
    let refused = false;
    for (const a of group) {
      const item = `${a.listing.storeId}:${a.listing.itemId}`;
      if (!firstInItem.has(item)) { firstInItem.set(item, a.row); continue; }
      if (shareSku) continue;
      errors.push({
        row: a.row,
        code: 'SHARED_SKU',
        message: `Master SKU "${a.masterSku}" juga dipakai varian lain dari produk yang sama (baris ${firstInItem.get(item)}). Ubah SKU-nya, atau centang "Stok dipakai bersama" kalau memang disengaja`,
      });
      refused = true;
    }
    if (refused) { sharedConflicts++; continue; }

    const typed = [...new Set(group.map(a => a.startStock).filter(s => s !== null))];
    if (typed.length > 1) {
      for (const a of group.filter(g => g.startStock !== null)) {
        errors.push({ row: a.row, message: `Stok Awal untuk Master SKU "${group[0].masterSku}" berbeda antarbaris (${typed.join(', ')}). Samakan, atau isi di satu baris saja` });
      }
      continue;
    }

    const readable = group.map(a => a.listing.stock).filter(s => s !== null && s !== undefined);
    const lowest = readable.length > 0 ? Math.max(0, Math.min(...readable)) : 0;
    const stock = typed.length === 1 ? typed[0] : lowest;
    if (typed.length === 0 && readable.length === 0) unreadStock++;

    const [leader] = group;
    const itemName = leader.listing.itemName || '';
    const parentName = leader.masterName || leader.listing.itemName || leader.listing.name;
    const parentKey = parentName.toLowerCase();
    if (!parents.has(parentKey)) parents.set(parentKey, { name: parentName, creates: [] });

    const spread = readable.length > 1 && Math.min(...readable) !== Math.max(...readable)
      ? { min: Math.min(...readable), max: Math.max(...readable) }
      : null;

    parents.get(parentKey).creates.push({
      masterSku: leader.masterSku,
      variantName: variantNameOf(leader.listing, itemName),
      stock,
      typed: typed.length === 1,
      spread,
      listingIds: group.map(a => a.listing.id),
      rows: group.map(a => a.row),
      stores: new Set(group.map(a => a.listing.storeId)).size,
      // Shops already holding the number need no push; one that does not, does.
      needsPush: group.some(a => a.listing.stock !== stock),
    });
  }

  const byRow = (a, b) => a.row - b.row;
  const parentList = [...parents.values()];
  const creates = parentList.flatMap(p => p.creates);

  return {
    ok: errors.length === 0,
    errors: errors.sort(byRow),
    warnings: warnings.sort(byRow),
    skipped: skipped.sort(byRow),
    parents: parentList,
    binds,
    pushIds: [...pushIds],
    sharedConflicts,
    counts: {
      rows: rows.length,
      parents: parentList.length,
      creates: creates.length,
      createdListings: creates.reduce((n, c) => n + c.listingIds.length, 0),
      binds: binds.length,
      skipped: skipped.length,
      unreadStock,
      spread: creates.filter(c => c.spread && !c.typed).length,
      push: creates.filter(c => c.needsPush).length + pushIds.size,
    },
  };
}

/**
 * Decide what an Import Stok file does, without doing it.
 *
 * The number in Stok Baru is a count from the warehouse, so it replaces the
 * master's stock rather than adding to it (PRD decision 3). A blank Stok Baru
 * means "not counted", not zero.
 *
 * All-or-nothing, like the per-master Edit Stok: the file is one stock count,
 * and half of it saved is harder to notice than an error.
 *
 * A row whose Stok Sekarang no longer matches OrderPro is still saved but
 * flagged `drifted`: an order has usually landed since the file was exported,
 * and the operator should know their count is about to overwrite it.
 *
 * @param {Array<{row: number, masterSku?: string, currentStock?: string, newStock?: string}>} rows
 * @param {Map<string, {id: string, masterSku: string, name: string, stock: number}>} mastersBySku - Keyed by normaliseSku
 */
function planStockImport(rows, mastersBySku) {
  const errors = [];
  const changes = [];
  const seen = new Map();
  let unchanged = 0;
  let blank = 0;

  for (const r of rows) {
    const next = parseStockCell(r.newStock);
    if (next.error) { errors.push({ row: r.row, message: `Stok Baru ${next.error}` }); continue; }
    if (next.value === null) { blank++; continue; }

    const sku = String(r.masterSku ?? '').trim();
    if (!sku) { errors.push({ row: r.row, message: 'Master SKU kosong' }); continue; }

    const key = normaliseSku(sku);
    const master = mastersBySku.get(key);
    if (!master) { errors.push({ row: r.row, message: `Master SKU "${sku}" tidak ditemukan` }); continue; }

    if (seen.has(key)) {
      const first = seen.get(key);
      if (first.value !== next.value) {
        errors.push({ row: r.row, message: `Master SKU "${sku}" juga ada di baris ${first.row} dengan angka berbeda (${first.value})` });
      }
      continue;
    }
    seen.set(key, { row: r.row, value: next.value });

    if (next.value === master.stock) { unchanged++; continue; }

    const exported = parseStockCell(r.currentStock);
    const exportedValue = 'value' in exported ? exported.value : null;
    changes.push({
      row: r.row,
      productId: master.id,
      masterSku: master.masterSku,
      name: master.name,
      from: master.stock,
      to: next.value,
      drifted: exportedValue !== null && exportedValue !== master.stock,
      exported: exportedValue,
    });
  }

  return {
    ok: errors.length === 0,
    errors: errors.sort((a, b) => a.row - b.row),
    changes,
    counts: {
      rows: rows.length,
      changes: changes.length,
      unchanged,
      blank,
      drifted: changes.filter(c => c.drifted).length,
    },
  };
}

module.exports = {
  MAX_ROWS,
  MASTER_COLUMNS,
  MASTER_REQUIRED,
  STOCK_COLUMNS,
  STOCK_REQUIRED,
  headerKey,
  parseStockCell,
  readRows,
  planMasterImport,
  planStockImport,
};
