'use strict';

/**
 * boost.js — Naikkan Produk (services/productBoost.js).
 *
 * Any operator with access to a shop may switch its auto-boost and boost now:
 * it is a daily selling chore, like it is in Komplace, not an admin setting.
 */

const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { authenticate } = require('../middleware/auth');
const { checkStoreAccess } = require('../middleware/storeAccess');
const { runStoreBoost, getStoreBoostState } = require('../services/productBoost');

router.use(authenticate);

async function visibleShopeeStores(user) {
  const where = { isActive: true, platform: 'SHOPEE' };
  if (user.role === 'STAFF') {
    const access = await prisma.storeAccess.findMany({
      where: { userId: user.id },
      select: { storeId: true },
    });
    where.id = { in: access.map(a => a.storeId) };
  }
  return prisma.store.findMany({ where, orderBy: { createdAt: 'asc' } });
}

/**
 * GET /
 * Every visible Shopee shop: switch, slots in use, next in line, history.
 */
router.get('/', async (req, res) => {
  try {
    const stores = await visibleShopeeStores(req.user);
    const data = await Promise.all(stores.map(getStoreBoostState));
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[boost] GET / failed:', err.message);
    return res.status(500).json({ success: false, error: 'Gagal memuat Naikkan Produk' });
  }
});

/**
 * PUT /:id
 * Body `{ enabled: boolean }`. Switching on runs a pass right away, so the
 * operator sees the first boosts without waiting for the next tick.
 */
router.put('/:id', checkStoreAccess, async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'enabled harus true atau false' });
  }
  try {
    const store = await prisma.store.findFirst({
      where: { id: req.params.id, platform: 'SHOPEE', isActive: true },
    });
    if (!store) return res.status(404).json({ success: false, error: 'Toko tidak ditemukan' });

    await prisma.store.update({ where: { id: store.id }, data: { autoBoost: enabled } });

    let run = null;
    let runError = null;
    if (enabled) {
      try {
        run = await runStoreBoost(store.id);
      } catch (err) {
        runError = err?.shopeeMessage || err?.message || 'Gagal menaikkan produk';
      }
    }
    return res.json({ success: true, data: { autoBoost: enabled, run, runError } });
  } catch (err) {
    console.error('[boost] PUT failed:', err.message);
    return res.status(500).json({ success: false, error: 'Gagal mengubah Naikkan Produk otomatis' });
  }
});

/**
 * POST /:id/run
 * Fill this shop's free slots now, whether auto-boost is on or not.
 */
router.post('/:id/run', checkStoreAccess, async (req, res) => {
  try {
    const store = await prisma.store.findFirst({
      where: { id: req.params.id, platform: 'SHOPEE', isActive: true },
    });
    if (!store) return res.status(404).json({ success: false, error: 'Toko tidak ditemukan' });

    const run = await runStoreBoost(store.id, { auto: false });
    return res.json({ success: true, data: run });
  } catch (err) {
    return res.status(502).json({
      success: false,
      error: err?.shopeeMessage || err?.message || 'Gagal menaikkan produk',
    });
  }
});

module.exports = router;
