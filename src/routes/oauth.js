'use strict';

const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client');
const { encrypt } = require('../utils/crypto');
const shopeeService = require('../services/shopee');
const tiktokService = require('../services/tiktok');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';

/**
 * GET /api/oauth/shopee/callback
 * Shopee redirects here after merchant authorization.
 * Query params: code, shop_id
 * Exchanges code for tokens, creates/updates store, redirects to frontend.
 */
router.get('/shopee/callback', async (req, res) => {
  try {
    const { code, shop_id } = req.query;

    if (!code) {
      console.error('[OAuth Shopee] No code in callback');
      return res.redirect(`${FRONTEND_URL}/admin/stores?error=${encodeURIComponent('Kode otorisasi tidak diterima dari Shopee')}`);
    }

    console.error(`[OAuth Shopee] Received code for shop_id=${shop_id}`);

    const tokenData = await shopeeService.getToken(code, shop_id || 0);

    const realShopId = String(tokenData.shop_id || shop_id);
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expire_in || 14400;

    if (!accessToken || !refreshToken) {
      throw new Error('Token tidak diterima dari Shopee');
    }

    let shopName = `Shopee Shop ${realShopId}`;
    try {
      const shopInfo = await shopeeService.getShopInfo(accessToken, realShopId);
      if (shopInfo.shop_name) {
        shopName = shopInfo.shop_name;
      }
    } catch (infoErr) {
      console.error('[OAuth Shopee] Could not fetch shop info:', infoErr.message);
    }

    const existing = await prisma.store.findFirst({
      where: { platform: 'SHOPEE', shopId: realShopId },
    });

    if (existing) {
      await prisma.store.update({
        where: { id: existing.id },
        data: {
          name: shopName,
          accessToken: encrypt(accessToken),
          refreshToken: encrypt(refreshToken),
          tokenExpiry: new Date(Date.now() + expiresIn * 1000),
          isActive: true,
        },
      });
      console.error(`[OAuth Shopee] Updated existing store ${existing.id}`);
    } else {
      await prisma.store.create({
        data: {
          name: shopName,
          platform: 'SHOPEE',
          shopId: realShopId,
          accessToken: encrypt(accessToken),
          refreshToken: encrypt(refreshToken),
          tokenExpiry: new Date(Date.now() + expiresIn * 1000),
          isActive: true,
        },
      });
      console.error(`[OAuth Shopee] Created new store for shop_id=${realShopId}`);
    }

    return res.redirect(`${FRONTEND_URL}/admin/stores?connected=shopee`);
  } catch (err) {
    console.error('[OAuth Shopee] Callback error:', err);
    return res.redirect(`${FRONTEND_URL}/admin/stores?error=${encodeURIComponent(err.message || 'Gagal menghubungkan Shopee')}`);
  }
});

/**
 * GET /api/oauth/tiktok/callback
 * TikTok redirects here after merchant authorization.
 * Query params: code, state
 */
router.get('/tiktok/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      console.error('[OAuth TikTok] No code in callback');
      return res.redirect(`${FRONTEND_URL}/admin/stores?error=${encodeURIComponent('Kode otorisasi tidak diterima dari TikTok')}`);
    }

    console.error(`[OAuth TikTok] Received code, state=${state}`);

    const tokenData = await tiktokService.getToken(code);

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expire_in || 86400;

    if (!accessToken || !refreshToken) {
      throw new Error('Token tidak diterima dari TikTok');
    }

    const shopId = state || `TIKTOK_${Date.now()}`;
    let shopName = 'TikTok Shop';

    const existing = await prisma.store.findFirst({
      where: { platform: 'TIKTOK', shopId },
    });

    if (existing) {
      await prisma.store.update({
        where: { id: existing.id },
        data: {
          name: shopName,
          accessToken: encrypt(accessToken),
          refreshToken: encrypt(refreshToken),
          tokenExpiry: new Date(Date.now() + expiresIn * 1000),
          isActive: true,
        },
      });
      console.error(`[OAuth TikTok] Updated existing store ${existing.id}`);
    } else {
      await prisma.store.create({
        data: {
          name: shopName,
          platform: 'TIKTOK',
          shopId,
          accessToken: encrypt(accessToken),
          refreshToken: encrypt(refreshToken),
          tokenExpiry: new Date(Date.now() + expiresIn * 1000),
          isActive: true,
        },
      });
      console.error(`[OAuth TikTok] Created new store for shop_id=${shopId}`);
    }

    return res.redirect(`${FRONTEND_URL}/admin/stores?connected=tiktok`);
  } catch (err) {
    console.error('[OAuth TikTok] Callback error:', err);
    return res.redirect(`${FRONTEND_URL}/admin/stores?error=${encodeURIComponent(err.message || 'Gagal menghubungkan TikTok')}`);
  }
});

module.exports = router;
