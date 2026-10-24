'use strict';

/**
 * products.js — the catalogue, masters, and master stock.
 *
 * Pulling the catalogue and mapping listings to masters never write to a
 * marketplace. Saving a master's stock does: the new number is pushed to every
 * Shopee listing bound to it (services/stockPush.js). Paid orders take master
 * stock on their own once stok otomatis is on (services/orderStock.js).
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const prisma = require('../prisma/client');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const {
  normaliseSku, planAutoMap, planStockEdit, parseStockItems,
  itemNameOf, variantNameOf, planMasterFromItem,
} = require('../services/productMapping');
const {
  syncAllCatalogues, syncStoreCatalogue, getLastPull, recordPull,
  syncAllStock, syncStoreStock, getLastStockSync, recordStockSync,
} = require('../services/productSync');
const { pushMasterStock } = require('../services/stockPush');
const {
  MAX_ROWS, MASTER_COLUMNS, MASTER_REQUIRED, STOCK_COLUMNS, STOCK_REQUIRED,
  readRows, planMasterImport, planStockImport,
} = require('../services/masterImport');
const { buildWorkbook, readSheet } = require('../services/importWorkbook');
const { stockPushQueue, hasQueueWorkers } = require('../services/queue');
const { getAutoDeductSince, setAutoDeduct } = require('../services/orderStock');

router.use(authenticate);

/** Page size ceiling, so a stray ?limit=100000 cannot pull 1300 rows at once. */
const MAX_LIMIT = 500;

/**
 * Stores this user may see.
 *
 * STAFF are scoped to their assignments the same way orders are; without this a
 * staff account would read the whole group's catalogue through a different URL.
 *
 * @returns {Promise<string[]|null>} Store ids, or null for "no restriction"
 */
async function visibleStoreIds(user) {
  if (user.role !== 'STAFF') return null;
  const access = await prisma.storeAccess.findMany({
    where: { userId: user.id },
    select: { storeId: true },
  });
  return access.map(a => a.storeId);
}

/**
 * GET /listings
 * The catalogue, filtered and paginated.
 *
 * Query: page, limit, storeId, status, search, mapped=yes|no
 */
router.get('/listings', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const where = {};

    const allowed = await visibleStoreIds(req.user);
    if (allowed) where.storeId = { in: allowed };

    if (req.query.storeId) {
      // Intersected with the allowed set rather than replacing it
      if (allowed && !allowed.includes(req.query.storeId)) {
        return res.json({ success: true, data: { listings: [], total: 0, page, limit } });
      }
      where.storeId = req.query.storeId;
    }

    if (req.query.status) where.status = req.query.status;

    // "Which listings still need a master?" is the question this whole screen
    // exists to answer, so it is a first-class filter rather than something to
    // eyeball down a column.
    if (req.query.mapped === 'no') where.productId = null;
    if (req.query.mapped === 'yes') where.productId = { not: null };

    if (req.query.search) {
      const search = String(req.query.search);
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
        { itemId: { contains: search } },
      ];
    }

    const [listings, total] = await Promise.all([
      prisma.productListing.findMany({
        where,
        include: {
          store: { select: { id: true, name: true, platform: true } },
          product: { select: { id: true, masterSku: true, name: true, stock: true } },
        },
        orderBy: [{ name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.productListing.count({ where }),
    ]);

    return res.json({
      success: true,
      data: { listings, total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('GET /products/listings error:', err);
    return res.status(500).json({ success: false, error: 'Gagal memuat katalog produk' });
  }
});

/**
 * GET /summary
 * Counts for the page header: how much has been pulled, and how much is mapped.
 */
router.get('/summary', async (req, res) => {
  try {
    const allowed = await visibleStoreIds(req.user);
    const where = allowed ? { storeId: { in: allowed } } : {};

    const [total, unmapped, masters, lastSynced] = await Promise.all([
      prisma.productListing.count({ where }),
      prisma.productListing.count({ where: { ...where, productId: null } }),
      prisma.product.count(),
      prisma.productListing.findFirst({
        where,
        orderBy: { lastSyncedAt: 'desc' },
        select: { lastSyncedAt: true },
      }),
    ]);

    return res.json({
      success: true,
      data: {
        listings: total,
        unmapped,
        mapped: total - unmapped,
        masters,
        lastSyncedAt: lastSynced?.lastSyncedAt ?? null,
        // Why the last pull produced what it did. Without this an operator
        // staring at an empty catalogue has no way to tell "Shopee refused us"
        // from "the shop really has nothing" — and the first is far likelier,
        // because the Product permission has never been confirmed on this app.
        lastPull: getLastPull(),
        // Same idea for the cheaper button: a refresh that Shopee refused looks
        // exactly like a refresh where nothing sold.
        lastStockSync: getLastStockSync(),
      },
    });
  } catch (err) {
    console.error('GET /products/summary error:', err);
    return res.status(500).json({ success: false, error: `Gagal memuat ringkasan produk: ${err.message}` });
  }
});

/**
 * POST /sync
 * Pull the catalogue from Shopee. Body: { storeId? } — omit to do every shop.
 *
 * Answers before the work finishes. A full pull is one call per multi-variant
 * listing, which on a 1300-item shop outlives any sensible HTTP timeout; the
 * outcome is readable afterwards from GET /summary.
 */
router.post('/sync', async (req, res) => {
  try {
    const { storeId } = req.body || {};

    if (storeId) {
      const allowed = await visibleStoreIds(req.user);
      if (allowed && !allowed.includes(storeId)) {
        return res.status(403).json({ success: false, error: 'Tidak punya akses ke toko ini' });
      }
    }

    res.json({
      success: true,
      data: {
        message: storeId
          ? 'Penarikan katalog untuk toko ini sedang berjalan'
          : 'Penarikan katalog untuk semua toko sedang berjalan',
        mode: 'inline',
      },
    });

    // Deliberately after the response, and deliberately not on the queue: a
    // catalogue pull is a rare, operator-initiated job, and putting it on the
    // sync queue would let it sit behind order syncs that matter more.
    try {
      if (storeId) {
        const one = await syncStoreCatalogue(storeId);
        recordPull({ stores: 1, listings: one.listings, failed: 0, errors: one.warnings || [] });
      } else {
        // syncAllCatalogues records its own outcome per store
        await syncAllCatalogues();
      }
      const done = getLastPull();
      console.log(`[catalogue] Pull finished: ${done?.listings ?? 0} listing(s), ${done?.failed ?? 0} store(s) failed`);
    } catch (err) {
      console.error('[catalogue] Pull failed:', err.message);
      recordPull({ stores: storeId ? 1 : 0, listings: 0, failed: 1, errors: [err.message] });
    }
  } catch (err) {
    console.error('POST /products/sync error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'Gagal memulai penarikan katalog' });
    }
  }
});

/**
 * POST /sync-stock
 * Re-read stock for listings already held. Body: { storeId? } — omit for all.
 *
 * Separate from /sync on purpose. A catalogue pull asks Shopee what exists and
 * costs a call per item plus the paging to find them; this asks only what the
 * items it already knows about now hold. Same answer shape, a fraction of the
 * work, which is what makes it reasonable to press often.
 *
 * Answers before the work finishes, like /sync, and for the same reason.
 */
router.post('/sync-stock', async (req, res) => {
  try {
    const { storeId } = req.body || {};

    if (storeId) {
      const allowed = await visibleStoreIds(req.user);
      if (allowed && !allowed.includes(storeId)) {
        return res.status(403).json({ success: false, error: 'Tidak punya akses ke toko ini' });
      }
    }

    res.json({
      success: true,
      data: {
        message: storeId
          ? 'Penyegaran stok untuk toko ini sedang berjalan'
          : 'Penyegaran stok untuk semua toko sedang berjalan',
        mode: 'inline',
      },
    });

    try {
      if (storeId) {
        const one = await syncStoreStock(storeId);
        recordStockSync({
          stores: 1,
          checked: one.checked,
          updated: one.updated,
          failed: 0,
          errors: one.warnings || [],
        });
      } else {
        // syncAllStock records its own outcome across stores
        await syncAllStock();
      }
      const done = getLastStockSync();
      console.log(`[stock] Refresh finished: ${done?.updated ?? 0} of ${done?.checked ?? 0} listing(s) changed`);
    } catch (err) {
      console.error('[stock] Refresh failed:', err.message);
      recordStockSync({ stores: storeId ? 1 : 0, checked: 0, updated: 0, failed: 1, errors: [err.message] });
    }
  } catch (err) {
    console.error('POST /products/sync-stock error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'Gagal memulai penyegaran stok' });
    }
  }
});

// ── Masters ───────────────────────────────────────────────────────────────────
//
// A master is the thing an operator actually thinks in: "Aylee Set — Khaki",
// one product, however many shops happen to list it. Mapping listings onto one
// is what makes a single stock figure meaningful. As in Komplace, one master SKU
// is one variation, grouped under a parent Master Produk per item — bundles are
// deliberately not modelled.

/** Nothing here will touch more listings than this in one request. */
const MAX_BATCH = 1000;

/**
 * Narrow a caller-supplied list of listing ids to the ones they may act on.
 *
 * Ids arrive from the browser, so they are a claim, not a fact: without this a
 * staff account could map a listing belonging to a shop it cannot even see by
 * pasting its id. Returns the rows rather than the ids because every caller
 * needs the store id anyway.
 *
 * @returns {Promise<Array<{id: string, storeId: string, sku: string|null}>>}
 */
async function scopeListings(user, listingIds) {
  if (!Array.isArray(listingIds) || listingIds.length === 0) {
    const err = new Error('listingIds wajib diisi');
    err.status = 400;
    throw err;
  }
  if (listingIds.length > MAX_BATCH) {
    const err = new Error(`Maksimal ${MAX_BATCH} listing sekali jalan`);
    err.status = 400;
    throw err;
  }

  const where = { id: { in: listingIds.map(String) } };
  const allowed = await visibleStoreIds(user);
  if (allowed) where.storeId = { in: allowed };

  return prisma.productListing.findMany({
    where,
    select: { id: true, storeId: true, sku: true },
  });
}

/**
 * GET /masters
 * The master list, with how many listings each one currently holds.
 *
 * Query: page, limit, search
 */
router.get('/masters', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const where = {};
    if (req.query.search) {
      const search = String(req.query.search);
      where.OR = [
        { masterSku: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [masters, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          _count: { select: { listings: true } },
          masterProduct: { select: { id: true, name: true } },
          listings: { where: { status: { in: ['NORMAL', 'UNLIST'] } }, select: { stock: true } },
        },
        orderBy: [{ masterSku: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.product.count({ where }),
    ]);

    // What the bound listings hold on the marketplace, as of the last refresh or
    // push. A range rather than one number: eleven shops can disagree, and a
    // master whose number is far from Shopee's is worth seeing before saving.
    const rows = masters.map(({ listings, ...m }) => {
      const known = listings.map(l => l.stock).filter(n => n !== null);
      return {
        ...m,
        listingStock: known.length === 0 ? null : { min: Math.min(...known), max: Math.max(...known) },
      };
    });

    return res.json({
      success: true,
      data: { masters: rows, total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('GET /products/masters error:', err);
    return res.status(500).json({ success: false, error: 'Gagal memuat master produk' });
  }
});

/**
 * POST /masters/draft
 * Build the "Jadikan Master" form for whatever items the selection touches.
 *
 * Body: { listingIds[] }
 *
 * Expands to every variation of each selected item, not just the ticked rows —
 * Komplace shows the whole item on one page, and a master made from two of five
 * colours leaves the other three to be found later as "belum dipetakan".
 * Nothing is written.
 */
router.post('/masters/draft', async (req, res) => {
  try {
    const picked = await scopeListings(req.user, req.body?.listingIds);
    if (picked.length === 0) {
      return res.status(404).json({ success: false, error: 'Listing tidak ditemukan' });
    }

    const pairs = await prisma.productListing.findMany({
      where: { id: { in: picked.map(l => l.id) } },
      select: { storeId: true, itemId: true },
      distinct: ['storeId', 'itemId'],
    });

    const siblings = await prisma.productListing.findMany({
      where: { OR: pairs.map(p => ({ storeId: p.storeId, itemId: p.itemId })) },
      include: {
        store: { select: { id: true, name: true } },
        product: { select: { id: true, masterSku: true } },
      },
      orderBy: [{ storeId: 'asc' }, { itemId: 'asc' }, { name: 'asc' }],
    });

    const groups = new Map();
    for (const l of siblings) {
      const key = `${l.storeId}:${l.itemId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l);
    }

    // Suggestions only: which SKUs already exist, so the form can say "joins the
    // existing master" before the operator presses the button rather than after.
    const existingBySku = await existingMastersBySku(
      prisma, siblings.map(l => l.sku),
    );

    const items = [...groups.values()].map((rows) => {
      const itemName = itemNameOf(rows);
      return {
        storeId: rows[0].storeId,
        storeName: rows[0].store?.name ?? '',
        itemId: rows[0].itemId,
        name: itemName,
        imageUrl: rows.find(r => r.imageUrl)?.imageUrl ?? null,
        variants: rows.map(r => ({
          listingId: r.id,
          variantName: variantNameOf(r, itemName),
          sku: r.sku,
          masterSku: r.sku ?? '',
          stock: r.stock,
          mappedTo: r.product?.masterSku ?? null,
          existingMaster: existingBySku.get(normaliseSku(r.sku))?.masterSku ?? null,
        })),
      };
    });

    return res.json({ success: true, data: { items } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error('POST /products/masters/draft error:', err);
    return res.status(500).json({ success: false, error: 'Gagal menyiapkan form master produk' });
  }
});

/**
 * Existing masters whose SKU matches any of these, keyed by normaliseSku.
 *
 * Case-insensitive on purpose: the unique index is not, so without this
 * "Belva-Black" and "belva-black" would become two masters for one variation.
 *
 * @param {Object} db - prisma, or a transaction client
 * @param {Array<string|null>} skus
 * @returns {Promise<Map<string, {id: string, masterSku: string}>>}
 */
async function existingMastersBySku(db, skus) {
  const keys = [...new Set(skus.map(normaliseSku).filter(Boolean))];
  if (keys.length === 0) return new Map();
  const found = await db.product.findMany({
    where: { OR: keys.map(sku => ({ masterSku: { equals: sku, mode: 'insensitive' } })) },
    select: { id: true, masterSku: true },
  });
  return new Map(found.map(p => [normaliseSku(p.masterSku), p]));
}

/**
 * POST /masters/from-items
 * "Jadikan Master": one parent per item, one Master SKU per variation.
 *
 * Body: { items: [{ name, shareSku?, variants: [{ listingId, masterSku }] }] }
 *
 * `shareSku` lets variations that sit on the same SKU share one master (a
 * jacket and its jacket-plus-jogger bundle); see planMasterFromItem.
 *
 * Each item is its own transaction and its own verdict, reported the way
 * Komplace reports it ("Berhasil: 4, Gagal: 1"). One item with a blank SKU
 * should not throw away the four that were filled in correctly.
 */
router.post('/masters/from-items', async (req, res) => {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Pilih minimal satu produk' });
    }

    const listingIds = items.flatMap(i => (Array.isArray(i?.variants) ? i.variants : []).map(v => v?.listingId));
    const scoped = await scopeListings(req.user, listingIds);

    const results = [];
    for (const item of items) {
      const label = String(item?.name ?? '').trim() || '(tanpa nama)';
      try {
        const outcome = await prisma.$transaction(async (tx) => {
          // Read inside the transaction and per item: an earlier item in this
          // same request may have just created the SKU, or mapped the listing,
          // that this one would otherwise act on from a stale copy.
          const rows = await tx.productListing.findMany({
            where: { id: { in: scoped.map(l => l.id) } },
            select: {
              id: true, name: true, itemId: true, modelId: true,
              itemName: true, modelName: true, stock: true, productId: true,
            },
          });
          const listingsById = new Map(rows.map(l => [l.id, l]));
          const existingBySku = await existingMastersBySku(
            tx, (item?.variants || []).map(v => v?.masterSku),
          );

          const plan = planMasterFromItem(item, listingsById, existingBySku);
          if (!plan.ok) return plan;

          let parent = null;
          if (plan.creates.length > 0) {
            parent = await tx.masterProduct.create({ data: { name: plan.name } });
            for (const c of plan.creates) {
              const product = await tx.product.create({
                data: {
                  masterProductId: parent.id,
                  masterSku: c.masterSku,
                  variantName: c.variantName,
                  name: c.variantName ? `${plan.name} — ${c.variantName}` : plan.name,
                  // The recording's Daftar Stok summed to exactly Shopee's figure:
                  // the listing's stock is where a master starts, not zero.
                  stock: c.stock,
                },
              });
              await tx.productListing.updateMany({
                where: { id: { in: [c.listingId, ...c.alsoListingIds] } },
                data: { productId: product.id },
              });
            }
          }
          for (const b of plan.binds) {
            await tx.productListing.update({ where: { id: b.listingId }, data: { productId: b.productId } });
          }

          return { ...plan, parentId: parent?.id ?? null };
        });

        if (!outcome.ok) {
          results.push({ name: label, ok: false, errors: outcome.errors });
          continue;
        }
        results.push({
          name: outcome.name,
          ok: true,
          masterProductId: outcome.parentId,
          created: outcome.creates.length,
          bound: outcome.binds.length,
          skipped: outcome.skipped.length,
          shared: outcome.shared,
          unreadStock: outcome.unreadStock,
        });
      } catch (err) {
        // The unique index still has the last word if two operators race.
        if (err.code === 'P2002') {
          results.push({ name: label, ok: false, errors: ['Master SKU bentrok dengan master yang baru saja dibuat — muat ulang lalu coba lagi'] });
        } else {
          console.error(`[masters] Jadikan Master "${label}" failed:`, err);
          results.push({ name: label, ok: false, errors: ['Gagal menyimpan produk ini'] });
        }
      }
    }

    const succeeded = results.filter(r => r.ok).length;
    console.log(`[masters] Jadikan Master: ${succeeded} berhasil, ${results.length - succeeded} gagal`);

    return res.json({
      success: true,
      data: { succeeded, failed: results.length - succeeded, results },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error('POST /products/masters/from-items error:', err);
    return res.status(500).json({ success: false, error: 'Gagal membuat master produk' });
  }
});

/**
 * PATCH /masters/:id
 * Body: { name?, stock?, isActive? }
 *
 * `masterSku` is not editable: it is the identity operators match against, and
 * renaming it silently re-points every listing bound to it.
 *
 * Sending `stock` pushes it to the bound Shopee listings, even when the number
 * is unchanged — that is how an operator re-sends a push that failed.
 */
router.patch('/masters/:id', async (req, res) => {
  try {
    const data = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ success: false, error: 'Nama tidak boleh kosong' });
      data.name = name;
    }
    if (req.body?.stock !== undefined) {
      const stock = Number(req.body.stock);
      if (!Number.isFinite(stock) || stock < 0) {
        return res.status(400).json({ success: false, error: 'Stok harus angka bulat, minimal 0' });
      }
      data.stock = Math.trunc(stock);
    }
    if (req.body?.isActive !== undefined) data.isActive = Boolean(req.body.isActive);

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: 'Tidak ada yang diubah' });
    }

    const before = data.stock !== undefined
      ? await prisma.product.findUnique({ where: { id: req.params.id }, select: { id: true, stock: true } })
      : null;
    const master = await prisma.product.update({ where: { id: req.params.id }, data });
    if (before) await recordManual([{ id: master.id, from: before.stock, to: master.stock }], req.user?.id);
    const push = data.stock !== undefined ? await pushAfterSave([master.id]) : null;
    return res.json({ success: true, data: { master, push } });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ success: false, error: 'Master produk tidak ditemukan' });
    }
    console.error('PATCH /products/masters/:id error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengubah master produk' });
  }
});

/**
 * Delete Master SKUs, and any parent left with no variation under it.
 *
 * Non-destructive to the catalogue: `onDelete: SetNull` returns every listing
 * bound to them to unmapped, so the item can go through "Jadikan Master"
 * again from scratch. What is lost is the typed stock number. Nothing on the
 * marketplace changes.
 *
 * @returns {Promise<{deleted:number, unmapped:number, parentsRemoved:number}>}
 */
async function deleteMasters(ids) {
  return prisma.$transaction(async (tx) => {
    const masters = await tx.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, masterSku: true, masterProductId: true, _count: { select: { listings: true } } },
    });
    if (masters.length === 0) return { deleted: 0, unmapped: 0, parentsRemoved: 0 };

    await tx.product.deleteMany({ where: { id: { in: masters.map(m => m.id) } } });

    // A parent is only a name over its variations; one with none left would sit
    // on the Master Produk list as an empty shell.
    const parentIds = [...new Set(masters.map(m => m.masterProductId).filter(Boolean))];
    const { count: parentsRemoved } = parentIds.length
      ? await tx.masterProduct.deleteMany({ where: { id: { in: parentIds }, variants: { none: {} } } })
      : { count: 0 };

    const unmapped = masters.reduce((sum, m) => sum + m._count.listings, 0);
    console.log(
      `[masters] Deleted ${masters.length} master(s) (${masters.map(m => m.masterSku).join(', ')}) — ` +
      `${unmapped} listing(s) returned to unmapped, ${parentsRemoved} empty parent(s) removed`
    );
    return { deleted: masters.length, unmapped, parentsRemoved };
  });
}

/**
 * DELETE /masters/:id
 * Admin only. See deleteMasters.
 */
router.delete('/masters/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    const result = await deleteMasters([req.params.id]);
    if (result.deleted === 0) {
      return res.status(404).json({ success: false, error: 'Master produk tidak ditemukan' });
    }
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('DELETE /products/masters/:id error:', err);
    return res.status(500).json({ success: false, error: 'Gagal menghapus master produk' });
  }
});

/**
 * POST /masters/delete
 * Admin only. Body: { productIds[] } — the "Hapus Master" action on Daftar Stok.
 */
router.post('/masters/delete', requireRole('ADMIN'), async (req, res) => {
  try {
    const ids = req.body?.productIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Pilih minimal satu master' });
    }
    if (ids.length > MAX_LIMIT) {
      return res.status(400).json({ success: false, error: `Maksimal ${MAX_LIMIT} master sekali hapus` });
    }
    const result = await deleteMasters(ids.map(String));
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /products/masters/delete error:', err);
    return res.status(500).json({ success: false, error: 'Gagal menghapus master produk' });
  }
});

/**
 * POST /listings/map
 * Bind existing listings to an existing master. Body: { listingIds[], productId }
 */
router.post('/listings/map', async (req, res) => {
  try {
    const productId = String(req.body?.productId ?? '').trim();
    if (!productId) {
      return res.status(400).json({ success: false, error: 'productId wajib diisi' });
    }

    const master = await prisma.product.findUnique({ where: { id: productId } });
    if (!master) {
      return res.status(404).json({ success: false, error: 'Master produk tidak ditemukan' });
    }

    const scoped = await scopeListings(req.user, req.body?.listingIds);
    const result = await prisma.productListing.updateMany({
      where: { id: { in: scoped.map(l => l.id) } },
      data: { productId },
    });

    return res.json({
      success: true,
      data: {
        mapped: result.count,
        skipped: req.body.listingIds.length - result.count,
        master: { id: master.id, masterSku: master.masterSku },
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error('POST /products/listings/map error:', err);
    return res.status(500).json({ success: false, error: 'Gagal memetakan listing ke master' });
  }
});

/**
 * POST /listings/unmap
 * Body: { listingIds[] }
 */
router.post('/listings/unmap', async (req, res) => {
  try {
    const scoped = await scopeListings(req.user, req.body?.listingIds);
    const result = await prisma.productListing.updateMany({
      where: { id: { in: scoped.map(l => l.id) } },
      data: { productId: null },
    });

    return res.json({ success: true, data: { unmapped: result.count } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error('POST /products/listings/unmap error:', err);
    return res.status(500).json({ success: false, error: 'Gagal melepas pemetaan' });
  }
});

/**
 * POST /masters/automap
 * Bind every unmapped listing whose marketplace SKU equals a master's SKU.
 *
 * This is the step that makes "the same product in six shops" one product: the
 * seller SKU is already the same string in every shop, because that is how the
 * operator types it. Body: { dryRun?: true } to count without writing.
 *
 * Only ever fills in blanks — a listing an operator has already mapped by hand
 * is never re-pointed, however well its SKU matches something else.
 */
router.post('/masters/automap', async (req, res) => {
  try {
    const dryRun = Boolean(req.body?.dryRun);

    const masters = await prisma.product.findMany({
      where: { isActive: true },
      select: { id: true, masterSku: true },
    });
    if (masters.length === 0) {
      return res.json({ success: true, data: { matched: 0, mapped: 0, masters: 0 } });
    }

    const where = { productId: null, sku: { not: null } };
    const allowed = await visibleStoreIds(req.user);
    if (allowed) where.storeId = { in: allowed };

    // productId is selected even though the query already filters on it being
    // null: planAutoMap re-checks it, and handing it a shape that cannot express
    // "already mapped" would make that guard untestable.
    const candidates = await prisma.productListing.findMany({
      where,
      select: { id: true, sku: true, productId: true },
    });

    const { plan, matched } = planAutoMap(masters, candidates);
    if (dryRun) {
      return res.json({ success: true, data: { matched, mapped: 0, masters: plan.size, dryRun: true } });
    }

    let mapped = 0;
    for (const [productId, ids] of plan) {
      // Chunked because a popular SKU can carry thousands of ids, and a single
      // IN list that long is a query planner problem rather than a feature.
      for (let i = 0; i < ids.length; i += MAX_BATCH) {
        const result = await prisma.productListing.updateMany({
          where: { id: { in: ids.slice(i, i + MAX_BATCH) } },
          data: { productId },
        });
        mapped += result.count;
      }
    }

    console.log(`[masters] Auto-map bound ${mapped} listing(s) across ${plan.size} master(s)`);
    return res.json({ success: true, data: { matched, mapped, masters: plan.size } });
  } catch (err) {
    console.error('POST /products/masters/automap error:', err);
    return res.status(500).json({ success: false, error: 'Gagal memetakan otomatis' });
  }
});

/**
 * Write Edit Stok into Riwayat Stok, so a number that changed by hand is as
 * traceable as one an order took. Unchanged rows (a re-push) are not history.
 * Best effort: the stock is saved already, and a missing history line is not
 * worth answering "gagal" over.
 *
 * @param {Array<{id: string, from: number, to: number}>} changes
 * @param {string} [kind] - MANUAL for Edit Stok, IMPORT for Import Stok
 */
async function recordManual(changes, userId, kind = 'MANUAL') {
  const rows = changes
    .filter(c => c.from !== undefined && c.from !== c.to)
    .map(c => ({ productId: c.id, kind, delta: c.to - c.from, stockAfter: c.to, userId: userId || null }));
  if (rows.length === 0) return;
  try {
    await prisma.stockMovement.createMany({ data: rows });
  } catch (err) {
    console.error('[masters] Could not record manual stock change:', err);
  }
}

/**
 * GET /stock-settings
 * Whether stok otomatis is on, and since when.
 */
router.get('/stock-settings', async (req, res) => {
  try {
    const since = await getAutoDeductSince();
    return res.json({ success: true, data: { autoDeductSince: since ? since.toISOString() : null } });
  } catch (err) {
    console.error('GET /products/stock-settings error:', err);
    return res.status(500).json({ success: false, error: 'Gagal memuat pengaturan stok' });
  }
});

/**
 * PUT /stock-settings
 * Body: { autoDeduct: boolean }
 *
 * Admin only: switching on makes every paid order across every shop move
 * stock, and it is only right after a stock opname.
 */
router.put('/stock-settings', requireRole('ADMIN'), async (req, res) => {
  try {
    if (typeof req.body?.autoDeduct !== 'boolean') {
      return res.status(400).json({ success: false, error: 'autoDeduct harus true atau false' });
    }
    const since = await setAutoDeduct(req.body.autoDeduct);
    console.log(`[masters] Stok otomatis ${since ? `ON since ${since.toISOString()}` : 'OFF'} by ${req.user?.email}`);
    return res.json({ success: true, data: { autoDeductSince: since ? since.toISOString() : null } });
  } catch (err) {
    console.error('PUT /products/stock-settings error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengubah pengaturan stok' });
  }
});

/**
 * GET /masters/:id/movements
 * Riwayat Stok for one master, newest first.
 *
 * Query: page, limit
 */
router.get('/masters/:id/movements', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const where = { productId: req.params.id };

    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        include: {
          store: { select: { name: true } },
          user: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.stockMovement.count({ where }),
    ]);

    return res.json({
      success: true,
      data: { movements, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error('GET /products/masters/:id/movements error:', err);
    return res.status(500).json({ success: false, error: 'Gagal memuat riwayat stok' });
  }
});

/**
 * Push saved masters to Shopee, without letting a push failure undo the save.
 *
 * By the time this runs the new number is in the database. A crash here (the
 * database dropping mid-push, say) must not answer 500, or the operator would
 * read "gagal" and type the same count in again on top of a save that worked.
 */
async function pushAfterSave(productIds) {
  try {
    return await pushMasterStock(productIds);
  } catch (err) {
    console.error('[masters] Stock saved but push failed:', err);
    return { listings: 0, pushed: 0, failed: [], skipped: [], error: 'Stok tersimpan, tapi gagal dikirim ke Shopee' };
  }
}

/**
 * POST /masters/stock
 * Set or adjust stock on many masters at once.
 *
 * Body: { productIds[], mode: 'set' | 'adjust', value }
 *    or: { items: [{ productId, stock }] }
 *
 *   set     stock becomes `value`
 *   adjust  stock becomes `stock + value`, floored at zero
 *   items   each master gets its own number — a stock count rarely comes back
 *           the same for every colour, so this is what the Daftar Stok dialog
 *           sends
 *
 * Adjust exists because the real action is almost never "this SKU now has 40" —
 * it is "30 more arrived". Making an operator read the current number, add to it
 * in their head and type the total is how a restock silently overwrites a sale
 * that landed in between.
 *
 * Rows are read and written inside one transaction rather than pushed through a
 * single `updateMany` with `increment`, because a decrement has to be floored
 * per row and `increment` would happily write -6.
 *
 * Once saved, every master in the request is pushed to its Shopee listings and
 * the outcome comes back as `push`. The save stands even if the push fails —
 * the operator sees which listings did not take it.
 */
router.post('/masters/stock', async (req, res) => {
  try {
    if (req.body?.items !== undefined) {
      const { writes, error } = parseStockItems(req.body.items, MAX_BATCH);
      if (error) return res.status(400).json({ success: false, error });

      const found = await prisma.product.findMany({
        where: { id: { in: writes.map(w => w.id) } },
        select: { id: true, stock: true },
      });
      if (found.length === 0) {
        return res.status(404).json({ success: false, error: 'Master produk tidak ditemukan' });
      }
      const current = new Map(found.map(m => [m.id, m.stock]));
      const valid = writes.filter(w => current.has(w.id));

      await prisma.$transaction(
        valid.map(w => prisma.product.update({ where: { id: w.id }, data: { stock: w.stock } })),
      );
      await recordManual(valid.map(w => ({ id: w.id, from: current.get(w.id), to: w.stock })), req.user?.id);

      console.log(`[masters] Stock set per master on ${valid.length} master(s)`);
      const push = await pushAfterSave(valid.map(w => w.id));

      return res.json({
        success: true,
        data: { updated: valid.length, clamped: 0, skipped: writes.length - valid.length, push },
      });
    }

    const productIds = req.body?.productIds;
    const mode = String(req.body?.mode ?? 'set');
    const value = Number(req.body?.value);

    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Pilih minimal satu master produk' });
    }
    if (productIds.length > MAX_BATCH) {
      return res.status(400).json({ success: false, error: `Maksimal ${MAX_BATCH} master sekali jalan` });
    }
    if (!['set', 'adjust'].includes(mode)) {
      return res.status(400).json({ success: false, error: 'mode harus "set" atau "adjust"' });
    }
    if (!Number.isFinite(value)) {
      return res.status(400).json({ success: false, error: 'Nilai stok harus angka' });
    }
    if (mode === 'set' && value < 0) {
      return res.status(400).json({ success: false, error: 'Stok tidak boleh negatif' });
    }

    const amount = Math.trunc(value);

    const masters = await prisma.product.findMany({
      where: { id: { in: productIds.map(String) } },
      select: { id: true, stock: true },
    });

    if (masters.length === 0) {
      return res.status(404).json({ success: false, error: 'Master produk tidak ditemukan' });
    }

    const { writes, clamped } = planStockEdit(masters, mode, amount);

    await prisma.$transaction(
      writes.map(w => prisma.product.update({ where: { id: w.id }, data: { stock: w.stock } })),
    );
    const was = new Map(masters.map(m => [m.id, m.stock]));
    await recordManual(writes.map(w => ({ id: w.id, from: was.get(w.id), to: w.stock })), req.user?.id);

    console.log(`[masters] Stock ${mode} ${amount} on ${masters.length} master(s), ${clamped} floored at 0`);
    const push = await pushAfterSave(masters.map(m => m.id));

    return res.json({
      success: true,
      data: {
        updated: masters.length,
        clamped,
        skipped: productIds.length - masters.length,
        push,
      },
    });
  } catch (err) {
    console.error('POST /products/masters/stock error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengubah stok master' });
  }
});

// ── Import Master & Import Stok (.xlsx) ──────────────────────────────────────
//
// PRD-import-xlsx.md. Both go download → edit in Excel → upload → preview →
// save. Simpan is sent back the rows the preview read rather than the file, and
// plans them again on fresh data: a listing may have been mapped, or a master
// sold down, while the operator was reading the preview.

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Most issues a preview lists by row; the rest are counted, not shown. */
const PREVIEW_LIST_LIMIT = 300;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/** multer.single, answering its own errors in Indonesian instead of as a 500. */
function uploadFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const error = err.code === 'LIMIT_FILE_SIZE' ? 'File maksimal 10 MB' : 'File gagal diunggah';
    return res.status(400).json({ success: false, error });
  });
}

/** Send a workbook as a download. */
function sendWorkbook(res, buffer, filename) {
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(buffer);
}

/** "20261024" — dates in file names sort, and say which day a count is from. */
function fileDate() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Read an uploaded workbook into rows.
 * @throws {Error} with `status` 400 when it is not a file this import can read
 */
async function readUpload(req, columns, required) {
  if (!req.file) {
    const err = new Error('Pilih file .xlsx dulu');
    err.status = 400;
    throw err;
  }
  const { rows, error } = readRows(await readSheet(req.file.buffer), columns, required);
  if (error) {
    const err = new Error(error);
    err.status = 400;
    throw err;
  }
  return rows;
}

/**
 * Rows as Simpan sends them back: only the known columns, as text, so a
 * hand-crafted request cannot smuggle anything the preview would not have read.
 */
function rowsFromBody(body, columns) {
  if (!Array.isArray(body) || body.length === 0) {
    const err = new Error('Tidak ada baris untuk disimpan');
    err.status = 400;
    throw err;
  }
  if (body.length > MAX_ROWS) {
    const err = new Error(`Maksimal ${MAX_ROWS} baris sekali impor`);
    err.status = 400;
    throw err;
  }
  return body.map((r) => {
    const out = { row: Number(r?.row) || 0 };
    for (const c of columns) {
      if (r?.[c.key] !== undefined && r?.[c.key] !== null) out[c.key] = String(r[c.key]);
    }
    return out;
  });
}

/**
 * Every master, keyed by normaliseSku. A few thousand rows at most, which is
 * cheaper than one case-insensitive OR clause per SKU in a 20,000-row file.
 */
async function allMastersBySku() {
  const masters = await prisma.product.findMany({
    select: { id: true, masterSku: true, name: true, stock: true },
  });
  return new Map(masters.map(m => [normaliseSku(m.masterSku), m]));
}

/** The listings an import names, limited to the shops this user may see. */
async function listingsForRows(user, rows) {
  const ids = [...new Set(rows.map(r => String(r.listingId ?? '').trim()).filter(Boolean))];
  const allowed = await visibleStoreIds(user);
  const found = [];
  // Chunked: Postgres caps one statement at 32,767 parameters.
  for (let i = 0; i < ids.length; i += 5000) {
    const where = { id: { in: ids.slice(i, i + 5000) } };
    if (allowed) where.storeId = { in: allowed };
    found.push(...await prisma.productListing.findMany({
      where,
      select: {
        id: true, storeId: true, itemId: true, modelId: true, name: true,
        itemName: true, modelName: true, stock: true, productId: true,
      },
    }));
  }
  return new Map(found.map(l => [l.id, l]));
}

/**
 * Push masters to Shopee without holding the request open: through the
 * stock-push queue when a worker is listening, otherwise in this process after
 * the response — the same fallback Publish uses.
 *
 * @returns {Promise<'none'|'queue'|'inline'>}
 */
async function pushInBackground(productIds) {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return 'none';
  if (await hasQueueWorkers(stockPushQueue)) {
    await stockPushQueue.add('push', { productIds: ids }, {
      // A failed push shows in the "Di Shopee" column; Edit Stok re-sends it.
      attempts: 1,
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 7 * 86400 },
    });
    return 'queue';
  }
  console.warn(`[masters] No stock-push worker — pushing ${ids.length} master(s) in the API process`);
  setImmediate(() => { pushAfterSave(ids); });
  return 'inline';
}

/** What a master-import preview shows; the full plan is far too big to send. */
function masterPreview(plan) {
  const creates = plan.parents.flatMap(p => p.creates.map(c => ({
    parent: p.name,
    masterSku: c.masterSku,
    variantName: c.variantName,
    stock: c.stock,
    typed: c.typed,
    spread: c.spread,
    listings: c.listingIds.length,
    stores: c.stores,
    rows: c.rows,
  })));
  // Merges and disagreements first: they are what the operator should check.
  creates.sort((a, b) => (Number(Boolean(b.spread)) - Number(Boolean(a.spread)))
    || (b.stores - a.stores) || (a.rows[0] - b.rows[0]));

  const skippedReasons = {};
  for (const s of plan.skipped) skippedReasons[s.reason] = (skippedReasons[s.reason] || 0) + 1;

  return {
    ok: plan.ok,
    counts: { ...plan.counts, errors: plan.errors.length, warnings: plan.warnings.length },
    errors: plan.errors.slice(0, PREVIEW_LIST_LIMIT),
    warnings: plan.warnings.slice(0, PREVIEW_LIST_LIMIT),
    sharedConflicts: plan.sharedConflicts,
    skippedReasons,
    creates: creates.slice(0, PREVIEW_LIST_LIMIT),
    binds: plan.binds.slice(0, PREVIEW_LIST_LIMIT),
  };
}

/**
 * GET /masters/import-template
 * Import Master, step 1: every listing still without a master, one row each,
 * with Master SKU pre-filled from the Shopee SKU.
 *
 * Query: storeId (optional) — one shop, for a file small enough to work through
 */
router.get('/masters/import-template', async (req, res) => {
  try {
    const where = { productId: null, status: { in: ['NORMAL', 'UNLIST'] } };
    const allowed = await visibleStoreIds(req.user);
    const storeId = req.query.storeId ? String(req.query.storeId) : null;
    if (storeId) {
      if (allowed && !allowed.includes(storeId)) {
        return res.status(403).json({ success: false, error: 'Kamu tidak punya akses ke toko ini' });
      }
      where.storeId = storeId;
    } else if (allowed) {
      where.storeId = { in: allowed };
    }

    const total = await prisma.productListing.count({ where });
    if (total > MAX_ROWS) {
      return res.status(400).json({
        success: false,
        error: `Ada ${total} listing belum punya master, lebih dari ${MAX_ROWS} untuk satu file. Pilih satu toko dulu.`,
      });
    }

    const listings = await prisma.productListing.findMany({
      where,
      include: { store: { select: { name: true } } },
      orderBy: [{ storeId: 'asc' }, { itemId: 'asc' }, { name: 'asc' }],
    });

    const items = new Map();
    for (const l of listings) {
      const key = `${l.storeId}:${l.itemId}`;
      if (!items.has(key)) items.set(key, []);
      items.get(key).push(l);
    }

    const rows = [];
    for (const siblings of items.values()) {
      const itemName = itemNameOf(siblings);
      for (const l of siblings) {
        rows.push({
          store: l.store?.name ?? '',
          product: itemName,
          variant: variantNameOf(l, itemName) ?? '',
          sku: l.sku ?? '',
          listingStock: l.stock ?? '',
          masterSku: l.sku ?? '',
          masterName: itemName,
          startStock: '',
          listingId: l.id,
        });
      }
    }
    rows.sort((a, b) => a.store.localeCompare(b.store, 'id') || a.product.localeCompare(b.product, 'id'));

    const buffer = await buildWorkbook({
      sheet: 'Master',
      columns: MASTER_COLUMNS,
      rows,
      guide: [
        'Cara mengisi Template Master',
        'Satu baris = satu varian listing Shopee yang belum punya master. Kolom berwarna kuning boleh diubah, yang lain hanya untuk dibaca.',
        'Master SKU — sudah diisi dari SKU Shopee. Baris dengan Master SKU sama dijadikan satu master, walaupun dari toko berbeda. Kalau SKU itu sudah ada di OrderPro, listingnya digabung ke master itu dan stoknya tidak diubah.',
        'Kosongkan Master SKU untuk melewati baris itu. Listingnya tetap belum punya master dan muncul lagi di template berikutnya.',
        'Varian paket (misalnya jaket + jogger) boleh diberi Master SKU yang sama dengan barang utamanya. Saat mengunggah, centang "Stok dipakai bersama".',
        'Nama Master Produk — baris dengan nama sama dikumpulkan di bawah satu induk Master Produk.',
        'Stok Awal — kosongkan untuk memakai stok Shopee. Kalau satu Master SKU ada di beberapa toko dengan stok berbeda, yang dipakai yang paling kecil. Isi angka bulat tanpa titik atau koma.',
        'ID (jangan diubah) — kunci untuk mencocokkan baris ke listing. Jangan diubah, dihapus, atau disalin ke baris lain.',
        'Simpan tetap sebagai .xlsx, lalu unggah di Produk → Import Master. Sebelum disimpan, OrderPro menampilkan pratinjau dulu.',
      ],
    });

    const store = storeId ? (listings[0]?.store?.name || 'toko') : 'semua-toko';
    const slug = store.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return sendWorkbook(res, buffer, `template-master-${slug}-${fileDate()}.xlsx`);
  } catch (err) {
    console.error('GET /products/masters/import-template error:', err);
    return res.status(500).json({ success: false, error: 'Gagal membuat template' });
  }
});

/**
 * POST /masters/import/preview
 * Import Master, step 2: read the uploaded file and say what Simpan would do.
 * Nothing is written.
 *
 * Multipart: file, shareSku ("true" to allow variations of one item on one SKU)
 *     or JSON: { rows, shareSku } — the rows a previous preview returned, so
 *     ticking "Stok dipakai bersama" re-plans without uploading again
 */
router.post('/masters/import/preview', uploadFile, async (req, res) => {
  try {
    const rows = req.file
      ? await readUpload(req, MASTER_COLUMNS, MASTER_REQUIRED)
      : rowsFromBody(req.body?.rows, MASTER_COLUMNS);
    const shareSku = req.body?.shareSku === true || req.body?.shareSku === 'true';
    const plan = planMasterImport(
      rows, await listingsForRows(req.user, rows), await allMastersBySku(), { shareSku },
    );
    return res.json({ success: true, data: { rows, ...masterPreview(plan) } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error('POST /products/masters/import/preview error:', err);
    return res.status(500).json({ success: false, error: 'Gagal membaca file' });
  }
});

/**
 * POST /masters/import
 * Import Master, step 3: create the masters.
 *
 * Body: { rows, shareSku? } — rows as the preview returned them
 *
 * One transaction per parent, reported like Jadikan Master: a parent whose SKU
 * someone else just created fails on its own and the rest are kept.
 */
router.post('/masters/import', async (req, res) => {
  try {
    const rows = rowsFromBody(req.body?.rows, MASTER_COLUMNS);
    const plan = planMasterImport(
      rows, await listingsForRows(req.user, rows), await allMastersBySku(),
      { shareSku: req.body?.shareSku === true },
    );
    if (!plan.ok) {
      return res.status(409).json({
        success: false,
        error: 'Data berubah sejak pratinjau dan sekarang ada baris yang salah. Unggah ulang filenya.',
        data: masterPreview(plan),
      });
    }

    const toPush = [];
    const failures = [];
    let parentsMade = 0;
    let mastersMade = 0;

    for (const parent of plan.parents) {
      try {
        const made = await prisma.$transaction(async (tx) => {
          const head = await tx.masterProduct.create({ data: { name: parent.name } });
          const push = [];
          for (const c of parent.creates) {
            const product = await tx.product.create({
              data: {
                masterProductId: head.id,
                masterSku: c.masterSku,
                variantName: c.variantName,
                name: c.variantName ? `${parent.name} — ${c.variantName}` : parent.name,
                stock: c.stock,
              },
            });
            // productId: null again here, not just in the plan: a listing mapped
            // by someone else since then must fail this parent, not be stolen.
            const bound = await tx.productListing.updateMany({
              where: { id: { in: c.listingIds }, productId: null },
              data: { productId: product.id },
            });
            if (bound.count !== c.listingIds.length) {
              const err = new Error('listing changed');
              err.code = 'LISTING_TAKEN';
              throw err;
            }
            if (c.needsPush) push.push(product.id);
          }
          return push;
        }, { timeout: 30_000 });
        parentsMade++;
        mastersMade += parent.creates.length;
        toPush.push(...made);
      } catch (err) {
        let reason = 'Gagal menyimpan';
        if (err.code === 'P2002') reason = 'Master SKU bentrok dengan master yang baru saja dibuat';
        else if (err.code === 'LISTING_TAKEN') reason = 'Sebagian listing baru saja dipetakan orang lain';
        else console.error(`[masters] Import "${parent.name}" failed:`, err);
        failures.push({ name: parent.name, reason, rows: parent.creates.flatMap(c => c.rows) });
      }
    }

    let bound = 0;
    const byMaster = new Map();
    for (const b of plan.binds) {
      if (!byMaster.has(b.productId)) byMaster.set(b.productId, []);
      byMaster.get(b.productId).push(b.listingId);
    }
    for (const [productId, ids] of byMaster) {
      const result = await prisma.productListing.updateMany({
        where: { id: { in: ids }, productId: null },
        data: { productId },
      });
      bound += result.count;
      if (result.count > 0 && plan.pushIds.includes(productId)) toPush.push(productId);
    }

    const pushMode = await pushInBackground(toPush);
    console.log(
      `[masters] Import: ${mastersMade} master(s) in ${parentsMade} parent(s), ${bound} listing(s) joined ` +
      `existing masters, ${failures.length} parent(s) failed, push ${toPush.length} (${pushMode})`
    );

    return res.json({
      success: true,
      data: {
        parents: parentsMade,
        masters: mastersMade,
        bound,
        skipped: plan.counts.skipped,
        unreadStock: plan.counts.unreadStock,
        failures,
        push: { masters: new Set(toPush).size, mode: pushMode },
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error('POST /products/masters/import error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengimpor master' });
  }
});

/**
 * GET /masters/stock-export
 * Export Stok: every master and its stock, with an empty Stok Baru to fill in.
 *
 * Query: search — the same filter as Daftar Stok
 */
router.get('/masters/stock-export', async (req, res) => {
  try {
    const where = {};
    if (req.query.search) {
      const search = String(req.query.search);
      where.OR = [
        { masterSku: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const masters = await prisma.product.findMany({
      where,
      include: {
        _count: { select: { listings: true } },
        masterProduct: { select: { name: true } },
      },
      orderBy: [{ masterSku: 'asc' }],
    });

    const buffer = await buildWorkbook({
      sheet: 'Stok',
      columns: STOCK_COLUMNS,
      rows: masters.map(m => ({
        masterSku: m.masterSku,
        masterName: m.masterProduct?.name ?? m.name,
        variant: m.variantName ?? '',
        bound: m._count.listings,
        currentStock: m.stock,
        newStock: '',
      })),
      guide: [
        'Cara mengisi Export Stok',
        'Isi kolom Stok Baru (kuning) dengan angka akhir hasil hitung gudang. Angka itu menggantikan stok master, bukan ditambahkan.',
        'Kosongkan Stok Baru untuk SKU yang tidak dihitung. Stoknya tidak diubah.',
        'Tulis angka bulat tanpa titik, koma, atau minus: 1200, bukan 1.200.',
        'Jangan ubah kolom Master SKU. Kolom lain hanya untuk dibaca.',
        'Stok Sekarang adalah stok saat file diunduh. Kalau berbeda saat diunggah (biasanya karena ada pesanan masuk), barisnya ditandai di pratinjau.',
        'Simpan tetap sebagai .xlsx, lalu unggah di Daftar Stok → Import Stok. Setelah disimpan, stok dikirim ke semua listing Shopee yang terikat.',
      ],
    });

    return sendWorkbook(res, buffer, `stok-master-${fileDate()}.xlsx`);
  } catch (err) {
    console.error('GET /products/masters/stock-export error:', err);
    return res.status(500).json({ success: false, error: 'Gagal membuat file stok' });
  }
});

/** What a stock-import preview shows. */
function stockPreview(plan) {
  // Rows that overwrite a sale come first; they are the ones to double-check.
  const changes = [...plan.changes].sort((a, b) => Number(b.drifted) - Number(a.drifted) || a.row - b.row);
  return {
    ok: plan.ok,
    counts: { ...plan.counts, errors: plan.errors.length },
    errors: plan.errors.slice(0, PREVIEW_LIST_LIMIT),
    changes: changes.slice(0, PREVIEW_LIST_LIMIT),
  };
}

/**
 * POST /masters/stock-import/preview
 * Import Stok, step 2: read the file and list what would change. Nothing is written.
 *
 * Multipart: file
 */
router.post('/masters/stock-import/preview', uploadFile, async (req, res) => {
  try {
    const rows = await readUpload(req, STOCK_COLUMNS, STOCK_REQUIRED);
    const plan = planStockImport(rows, await allMastersBySku());
    return res.json({ success: true, data: { rows, ...stockPreview(plan) } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error('POST /products/masters/stock-import/preview error:', err);
    return res.status(500).json({ success: false, error: 'Gagal membaca file' });
  }
});

/**
 * POST /masters/stock-import
 * Import Stok, step 3: set every counted master, write Riwayat Stok, push.
 *
 * Body: { rows } — as the preview returned them
 */
router.post('/masters/stock-import', async (req, res) => {
  try {
    const rows = rowsFromBody(req.body?.rows, STOCK_COLUMNS);
    const plan = planStockImport(rows, await allMastersBySku());
    if (!plan.ok) {
      return res.status(409).json({
        success: false,
        error: 'Data berubah sejak pratinjau dan sekarang ada baris yang salah. Unggah ulang filenya.',
        data: stockPreview(plan),
      });
    }

    // `from` is re-read inside the write: an order taken between preview and
    // Simpan belongs in Riwayat Stok as what this count replaced.
    const changes = [];
    for (let i = 0; i < plan.changes.length; i += 500) {
      const chunk = plan.changes.slice(i, i + 500);
      const written = await prisma.$transaction(async (tx) => {
        const now = await tx.product.findMany({
          where: { id: { in: chunk.map(c => c.productId) } },
          select: { id: true, stock: true },
        });
        const was = new Map(now.map(m => [m.id, m.stock]));
        for (const c of chunk) {
          await tx.product.update({ where: { id: c.productId }, data: { stock: c.to } });
        }
        return chunk.map(c => ({ id: c.productId, from: was.get(c.productId), to: c.to }));
      }, { timeout: 30_000 });
      changes.push(...written);
    }

    await recordManual(changes, req.user?.id, 'IMPORT');
    const pushMode = await pushInBackground(changes.map(c => c.id));
    console.log(`[masters] Stock import: ${changes.length} master(s) set, push ${pushMode}`);

    return res.json({
      success: true,
      data: {
        updated: changes.length,
        unchanged: plan.counts.unchanged,
        blank: plan.counts.blank,
        push: { masters: changes.length, mode: pushMode },
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error('POST /products/masters/stock-import error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengimpor stok' });
  }
});

module.exports = router;
