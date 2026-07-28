'use strict';

const express = require('express');
const prisma = require('../prisma/client');
const { encrypt, decrypt } = require('../utils/crypto');
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/role');
const shopeeService = require('../services/shopee');
const tiktokService = require('../services/tiktok');

const router = express.Router();

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
      status: store.isActive ? 'ACTIVE' : 'ERROR',
      lastSyncAt: store.updatedAt,
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

    const data = {
      name,
      platform,
      shopId,
      tokenExpiry: new Date(Date.now() + 4 * 60 * 60 * 1000),
    };

    if (accessToken) {
      data.accessToken = encrypt(accessToken);
    }
    if (refreshToken) {
      data.refreshToken = encrypt(refreshToken);
    }

    const store = await prisma.store.create({ data });

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
