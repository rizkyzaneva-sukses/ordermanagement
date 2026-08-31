'use strict';

const express = require('express');
const prisma = require('../prisma/client');
const { encrypt, decrypt } = require('../utils/crypto');
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/role');
const shopeeService = require('../services/shopee');
const tiktokService = require('../services/tiktok');

const router = express.Router();

// Lazy-load scheduler to avoid circular dependencies
function getScheduler() {
  try { return require('../services/scheduler'); } catch { return null; }
}

/**
 * One label for the several ways a store can be unhealthy.
 *
 * Ordered by what the operator has to do about it, most drastic first: a store
 * flagged needsReconnect can only be fixed by re-authorizing at the
 * marketplace, so saying "token kadaluarsa" there would send them to a Reconnect
 * button that is guaranteed to fail. A sync that errored comes last because the
 * credentials are fine and the next run may well succeed.
 */
function storeStatus(store) {
  if (!store.isActive) return 'ERROR';
  if (store.needsReconnect) return 'NEEDS_RECONNECT';
  if (store.tokenExpiry && new Date(store.tokenExpiry) < new Date()) return 'TOKEN_EXPIRED';
  if (store.lastSyncStatus === 'ERROR') return 'SYNC_ERROR';
  // A run that lost one status pass finished, but not completely: the orders in
  // that status were never refreshed, and their rows go stale without anything
  // looking broken. Sync has recorded this all along; this page was showing it
  // as a healthy "Terhubung", which is how drift stays invisible until someone
  // compares against Seller Centre by hand.
  if (store.lastSyncStatus === 'PARTIAL') return 'SYNC_PARTIAL';
  return 'ACTIVE';
}

router.use(authenticate);

/**
 * GET /
 * List stores with order count, status, and lastSyncAt
 */
router.get('/', async (req, res) => {
  try {
    const user = req.user;
    let where = { isActive: true };

    if (user.role === 'STAFF') {
      const access = await prisma.storeAccess.findMany({
        where: { userId: user.id },
        select: { storeId: true },
      });
      where.id = { in: access.map((a) => a.storeId) };
    }

    const stores = await prisma.store.findMany({
      where,
      include: {
        _count: {
          select: { orders: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const data = stores.map((store) => ({
      id: store.id,
      name: store.name,
      platform: store.platform,
      shopId: store.shopId,
      isActive: store.isActive,
      status: storeStatus(store),
      // The schema has recorded all of this since sync learned to report
      // failures, but the list withheld it — so a shop whose token died and a
      // shop with genuinely no orders both showed up as "Terhubung", and the
      // difference only surfaced as orders quietly missing from the table.
      needsReconnect: store.needsReconnect,
      lastSyncStatus: store.lastSyncStatus || null,
      lastSyncError: store.lastSyncError || null,
      lastSyncAttemptAt: store.lastSyncAttemptAt || null,
      lastSyncAt: store.lastSyncAt || store.updatedAt,
      orderCount: store._count.orders,
      createdAt: store.createdAt,
      updatedAt: store.updatedAt,
    }));

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to list stores' });
  }
});

// Admin-only middleware for remaining store modifications
router.use(requireAdmin());

/**
 * GET /authorized
 * Which Shopee shops have authorized this app, and which of them are missing
 * from OrderPro.
 *
 * Until now a shop that was never connected was invisible: its orders simply
 * did not arrive, and no screen said they were absent. The operator only found
 * out by noticing an order in Seller Centre that OrderPro had never heard of —
 * which is the exact moment they stop trusting OrderPro and reopen Komplace.
 *
 * Shopee's own list is the authority here, so this reads it live rather than
 * inferring anything from what happens to be in the database.
 *
 * Answers 200 with `supported: false` when the list cannot be fetched at all
 * (no partner credentials configured, or Shopee refusing the call). A missing
 * comparison is not the same as a clean bill of health, and a red error box
 * would imply something is broken with the shops themselves.
 */
router.get('/authorized', async (req, res) => {
  if (!process.env.SHOPEE_PARTNER_ID || !process.env.SHOPEE_PARTNER_KEY) {
    return res.json({
      success: true,
      data: {
        supported: false,
        reason: 'Kredensial partner Shopee belum diisi di server (SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY)',
      },
    });
  }

  try {
    const [authorized, stores] = await Promise.all([
      shopeeService.getAllShopsByPartner(),
      prisma.store.findMany({
        where: { platform: 'SHOPEE' },
        select: { id: true, name: true, shopId: true, isActive: true, needsReconnect: true },
      }),
    ]);

    const known = new Map(stores.map((s) => [String(s.shopId), s]));
    const authorizedIds = new Set(authorized.map((a) => a.shopId));
    const nowSec = Math.floor(Date.now() / 1000);

    // Authorized at Shopee, absent from OrderPro — the shops whose orders no
    // one here has ever seen.
    const unlinked = authorized
      .filter((a) => !known.has(a.shopId))
      .map((a) => ({
        shopId:     a.shopId,
        authTime:   a.authTime,
        expireTime: a.expireTime,
        expired:    a.expireTime ? a.expireTime < nowSec : false,
      }));

    // The mirror image: a store row we go on syncing although Shopee no longer
    // lists it as authorized. Its orders stopped arriving some time ago.
    const revoked = stores
      .filter((s) => s.isActive && !authorizedIds.has(String(s.shopId)))
      .map((s) => ({ id: s.id, name: s.name, shopId: s.shopId }));

    return res.json({
      success: true,
      data: {
        supported:       true,
        authorizedCount: authorized.length,
        linkedCount:     authorized.length - unlinked.length,
        unlinked,
        revoked,
      },
    });
  } catch (err) {
    console.error('[stores] Could not list authorized shops:', err.message);
    return res.json({
      success: true,
      data: {
        supported: false,
        reason: `Shopee tidak bisa dimintai daftar toko terotorisasi: ${err.message}`,
      },
    });
  }
});

/**
 * POST /quick-connect
 * 1-Click login authorization for Shopee and TikTok Shop.
 * Returns the OAuth URL — the frontend redirects the user there.
 * The actual store is created after the OAuth callback completes.
 */
router.post('/quick-connect', async (req, res) => {
  try {
    const { platform } = req.body;
    if (!platform || !['SHOPEE', 'TIKTOK'].includes(platform)) {
      return res.status(400).json({ success: false, error: 'Platform valid (SHOPEE atau TIKTOK) diperlukan' });
    }

    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
    let authUrl;

    if (platform === 'SHOPEE') {
      const redirectUri = `${backendUrl}/api/oauth/shopee/callback`;
      authUrl = shopeeService.getAuthUrl(redirectUri);
    } else {
      const redirectUri = `${backendUrl}/api/oauth/tiktok/callback`;
      authUrl = tiktokService.getAuthUrl('', redirectUri);
    }

    return res.json({
      success: true,
      data: { authUrl },
    });
  } catch (err) {
    console.error('Quick connect error:', err);
    return res.status(500).json({ success: false, error: 'Gagal menghubungkan toko' });
  }
});

/**
 * POST /
 * Add a new store
 * Body: { name, platform, shopId, accessToken, refreshToken }
 * Tokens are encrypted before storage
 */
router.post('/', async (req, res) => {
  try {
    const { name, platform, shopId, accessToken, refreshToken } = req.body;

    if (!name || !platform || !shopId) {
      return res.status(400).json({ success: false, error: 'name, platform, and shopId are required' });
    }

    // Both are NOT NULL in the schema, so omitting them fails inside Prisma and
    // surfaces as an opaque 500. Reject it here with something actionable.
    if (!accessToken || !refreshToken) {
      return res.status(400).json({ success: false, error: 'accessToken and refreshToken are required' });
    }

    const expiryHours = platform === 'TIKTOK' ? 24 : 4;
    const store = await prisma.store.create({
      data: {
        name,
        platform,
        shopId,
        accessToken: encrypt(accessToken),
        refreshToken: encrypt(refreshToken),
        tokenExpiry: new Date(Date.now() + expiryHours * 60 * 60 * 1000),
      },
    });

    // Stores added this way are active immediately, but only the OAuth callback
    // used to schedule them — so a manually added store never auto-synced until
    // the next server restart.
    const scheduler = getScheduler();
    if (scheduler) {
      scheduler.addStore(store.id).catch((err) =>
        console.warn(`[stores] Could not register scheduled sync for store ${store.id}:`, err.message)
      );
    }

    return res.status(201).json({
      success: true,
      data: {
        id: store.id,
        name: store.name,
        platform: store.platform,
        shopId: store.shopId,
        isActive: store.isActive,
        createdAt: store.createdAt,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to create store' });
  }
});

/**
 * PATCH /:id
 * Update store fields
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, platform, shopId, accessToken, refreshToken } = req.body;

    const existing = await prisma.store.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Store not found' });
    }

    const data = {};
    if (name !== undefined) data.name = name;
    if (platform !== undefined) data.platform = platform;
    if (shopId !== undefined) data.shopId = shopId;
    if (accessToken !== undefined) data.accessToken = encrypt(accessToken);
    if (refreshToken !== undefined) data.refreshToken = encrypt(refreshToken);

    const store = await prisma.store.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        platform: true,
        shopId: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({ success: true, data: store });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to update store' });
  }
});

/**
 * DELETE /:id
 * Soft delete: set isActive = false
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.store.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Store not found' });
    }

    await prisma.store.update({
      where: { id },
      data: { isActive: false },
    });

    // Stop the repeatable sync. The job outlives the store otherwise: it keeps
    // firing every interval and runStoreSync happily syncs a deactivated store,
    // so a "disconnected" shop would go on pulling orders indefinitely.
    const scheduler = getScheduler();
    if (scheduler) {
      scheduler.removeStore(id).catch((err) =>
        console.warn(`[stores] Could not remove scheduled sync for store ${id}:`, err.message)
      );
    }

    return res.json({ success: true, data: { message: 'Store deactivated' } });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to delete store' });
  }
});

/**
 * POST /:id/reconnect
 * Refresh marketplace token using stored refreshToken
 */
router.post('/:id/reconnect', async (req, res) => {
  try {
    const { id } = req.params;

    const store = await prisma.store.findUnique({ where: { id } });
    if (!store) {
      return res.status(404).json({ success: false, error: 'Store not found' });
    }

    if (!store.refreshToken) {
      return res.status(400).json({ success: false, error: 'No refresh token stored for this store' });
    }

    const refreshToken = decrypt(store.refreshToken);

    // Platform-specific token refresh — delegate to service methods (correct signing)
    let newAccessToken;
    let newRefreshToken;

    switch (store.platform) {
      case 'SHOPEE': {
        const result = await shopeeService.refreshToken(refreshToken, store.shopId);
        newAccessToken = result.access_token;
        newRefreshToken = result.refresh_token;
        break;
      }
      case 'TIKTOK': {
        const result = await tiktokService.refreshToken(refreshToken);
        newAccessToken = result.access_token;
        newRefreshToken = result.refresh_token;
        break;
      }
      default:
        return res.status(400).json({ success: false, error: `Unsupported platform: ${store.platform}` });
    }

    // Update stored tokens + expiry
    // Shopee access token: ~4 hours; TikTok access token: ~24 hours
    const expiryHours = store.platform === 'TIKTOK' ? 24 : 4;
    const updateData = {
      tokenExpiry: new Date(Date.now() + expiryHours * 60 * 60 * 1000),
      // The refresh just succeeded, so the store is healthy again. Without this
      // refreshExpiringTokens() would keep skipping it (it only considers stores
      // with needsReconnect = false) and automatic upkeep would never resume.
      needsReconnect: false,
    };
    if (newAccessToken) updateData.accessToken = encrypt(newAccessToken);
    if (newRefreshToken) updateData.refreshToken = encrypt(newRefreshToken);

    const updated = await prisma.store.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        platform: true,
        shopId: true,
        isActive: true,
        updatedAt: true,
      },
    });

    return res.json({ success: true, data: updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: `Reconnect failed: ${err.message}` });
  }
});

module.exports = router;
