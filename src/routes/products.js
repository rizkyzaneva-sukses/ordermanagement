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
const { syncAllCatalogues, syncStoreCatalogue } = require('../services/productSync');

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
      },
    });
  } catch (err) {
    console.error('GET /products/summary error:', err);
    return res.status(500).json({ success: false, error: 'Gagal memuat ringkasan produk' });
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
      const result = storeId ? [await syncStoreCatalogue(storeId)] : await syncAllCatalogues();
      const listings = result.reduce((sum, r) => sum + r.listings, 0);
      console.log(`[catalogue] Pull finished: ${listings} listing(s) across ${result.length} store(s)`);
    } catch (err) {
      console.error('[catalogue] Pull failed:', err.message);
    }
  } catch (err) {
    console.error('POST /products/sync error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'Gagal memulai penarikan katalog' });
    }
  }
});

module.exports = router;
