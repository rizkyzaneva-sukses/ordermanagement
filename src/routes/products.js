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
const {
  normaliseSku, planAutoMap, planStockEdit,
  itemNameOf, variantNameOf, planMasterFromItem,
} = require('../services/productMapping');
const {
  syncAllCatalogues, syncStoreCatalogue, getLastPull, recordPull,
  syncAllStock, syncStoreStock, getLastStockSync, recordStockSync,
} = require('../services/productSync');

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
        },
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
 * Body: { items: [{ name, variants: [{ listingId, masterSku }] }] }
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
              await tx.productListing.update({ where: { id: c.listingId }, data: { productId: product.id } });
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

/**
 * POST /masters/stock
 * Set or adjust stock on many masters at once.
 *
 * Body: { productIds[], mode: 'set' | 'adjust', value }
 *
 *   set     stock becomes `value`
 *   adjust  stock becomes `stock + value`, floored at zero
 *
 * Adjust exists because the real action is almost never "this SKU now has 40" —
 * it is "30 more arrived". Making an operator read the current number, add to it
 * in their head and type the total is how a restock silently overwrites a sale
 * that landed in between.
 *
 * Rows are read and written inside one transaction rather than pushed through a
 * single `updateMany` with `increment`, because a decrement has to be floored
 * per row and `increment` would happily write -6.
 */
router.post('/masters/stock', async (req, res) => {
  try {
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

    console.log(`[masters] Stock ${mode} ${amount} on ${masters.length} master(s), ${clamped} floored at 0`);

    return res.json({
      success: true,
      data: {
        updated: masters.length,
        clamped,
        skipped: productIds.length - masters.length,
      },
    });
  } catch (err) {
    console.error('POST /products/masters/stock error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengubah stok master' });
  }
});

module.exports = router;
