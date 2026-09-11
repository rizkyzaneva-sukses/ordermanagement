'use strict';

/**
 * products.js — the catalogue, read-only.
 *
 * This is the first half of the product feature: pull what Shopee has and show
 * it. Mapping listings to masters and pushing stock back are separate steps, and
 * the second of them needs a product write permission this app has not been
 * confirmed to hold — so nothing here writes to a marketplace.
 */

const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const { planAutoMap } = require('../services/productMapping');
const {
  syncAllCatalogues, syncStoreCatalogue, getLastPull, recordPull,
  syncAllStock, syncStoreStock, getLastStockSync, recordStockSync,
} = require('../services/productSync');

router.use(authenticate);

/** Page size ceiling, so a stray ?limit=100000 cannot pull 1300 rows at once. */
const MAX_LIMIT = 100;

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
// is what makes a single stock figure meaningful, and per PROSES KOMPLACE it is
// one master to one SKU — bundles are deliberately not modelled.

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
        include: { _count: { select: { listings: true } } },
        orderBy: [{ masterSku: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.product.count({ where }),
    ]);

    return res.json({
      success: true,
      data: { masters, total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('GET /products/masters error:', err);
    return res.status(500).json({ success: false, error: 'Gagal memuat master produk' });
  }
});

/**
 * POST /masters
 * Create a master, optionally binding listings to it in the same step.
 *
 * Body: { masterSku, name, stock?, listingIds?[] }
 *
 * Creating and mapping are one request because in the Komplace flow they are one
 * action ("Jadikan Master"): a master created with nothing attached is a row an
 * operator has no way to notice they left behind.
 */
router.post('/masters', async (req, res) => {
  try {
    const masterSku = String(req.body?.masterSku ?? '').trim();
    const name = String(req.body?.name ?? '').trim() || masterSku;
    const listingIds = req.body?.listingIds;

    if (!masterSku) {
      return res.status(400).json({ success: false, error: 'Nama SKU master wajib diisi' });
    }

    // Typed by an operator, so it is worth saying what is wrong rather than
    // letting the unique constraint surface as a 500.
    const clash = await prisma.product.findUnique({ where: { masterSku } });
    if (clash) {
      return res.status(409).json({
        success: false,
        error: `SKU master "${masterSku}" sudah ada — petakan ke master itu, jangan buat baru`,
        data: { existingId: clash.id },
      });
    }

    // Stock is typed, never derived. See PROSES KOMPLACE: the operator keys it
    // the same way they do in Komplace, and nothing decrements it automatically.
    const stock = Number.isFinite(Number(req.body?.stock)) ? Math.trunc(Number(req.body.stock)) : 0;

    let scoped = [];
    if (listingIds !== undefined) {
      scoped = await scopeListings(req.user, listingIds);
    }

    const master = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: { masterSku, name, stock },
      });

      if (scoped.length > 0) {
        await tx.productListing.updateMany({
          where: { id: { in: scoped.map(l => l.id) } },
          data: { productId: created.id },
        });
      }

      return created;
    });

    console.log(`[masters] Created "${masterSku}" with ${scoped.length} listing(s) mapped`);

    return res.status(201).json({
      success: true,
      data: {
        master,
        mapped: scoped.length,
        // Says plainly when some of what was selected could not be acted on,
        // rather than reporting a smaller number with no explanation.
        skipped: Array.isArray(listingIds) ? listingIds.length - scoped.length : 0,
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error('POST /products/masters error:', err);
    return res.status(500).json({ success: false, error: 'Gagal membuat master produk' });
  }
});

/**
 * PATCH /masters/:id
 * Body: { name?, stock?, isActive? }
 *
 * `masterSku` is not editable: it is the identity operators match against, and
 * renaming it silently re-points every listing bound to it.
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

    const master = await prisma.product.update({ where: { id: req.params.id }, data });
    return res.json({ success: true, data: { master } });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ success: false, error: 'Master produk tidak ditemukan' });
    }
    console.error('PATCH /products/masters/:id error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengubah master produk' });
  }
});

/**
 * DELETE /masters/:id
 *
 * Admin only, and non-destructive to the catalogue: `onDelete: SetNull` returns
 * every listing bound to it to unmapped rather than deleting it with the master.
 */
router.delete('/masters/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    const master = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { listings: true } } },
    });
    if (!master) {
      return res.status(404).json({ success: false, error: 'Master produk tidak ditemukan' });
    }

    await prisma.product.delete({ where: { id: req.params.id } });
    console.log(`[masters] Deleted "${master.masterSku}" — ${master._count.listings} listing(s) returned to unmapped`);

    return res.json({ success: true, data: { unmapped: master._count.listings } });
  } catch (err) {
    console.error('DELETE /products/masters/:id error:', err);
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

module.exports = router;
