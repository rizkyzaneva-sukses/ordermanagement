'use strict';

/**
 * chat.js — Shopee chat inbox. Mounted at /api/chat.
 *
 * Thin: access rules, Shopee calls and error wording live in services/chat.js.
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const chat = require('../services/chat');

router.use(authenticate);

// Shopee's own limits for a chat image: jpg/jpeg/png/gif, at most 10 MB
const CHAT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, CHAT_IMAGE_TYPES.includes(file.mimetype)),
});

function sendError(res, err, fallback) {
  if (err.statusCode) {
    return res.status(err.statusCode).json({ success: false, error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  console.error(`[chat] ${fallback}:`, err);
  return res.status(500).json({ success: false, error: fallback });
}

/** GET /stores — the Shopee stores this user may chat for, for the filter. */
router.get('/stores', async (req, res) => {
  try {
    const stores = await chat.storesFor(req.user);
    res.json({ success: true, data: stores.map(s => ({ id: s.id, name: s.name })) });
  } catch (err) {
    sendError(res, err, 'Gagal memuat toko');
  }
});

/** GET /unread — unread conversation count, total and per store. */
router.get('/unread', async (req, res) => {
  try {
    res.json({ success: true, data: await chat.unreadCounts(req.user) });
  } catch (err) {
    sendError(res, err, 'Gagal memuat jumlah chat');
  }
});

/** GET /conversations?storeId=&type=all|unread&cursor= */
router.get('/conversations', async (req, res) => {
  try {
    const { storeId, type, cursor } = req.query;
    res.json({ success: true, data: await chat.listConversations(req.user, { storeId, type, cursor }) });
  } catch (err) {
    sendError(res, err, 'Gagal memuat percakapan');
  }
});

/** GET /conversations/:id/messages?storeId=&offset= */
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const { storeId, offset } = req.query;
    res.json({
      success: true,
      data: await chat.listMessages(req.user, { storeId, conversationId: req.params.id, offset }),
    });
  } catch (err) {
    sendError(res, err, 'Gagal memuat pesan');
  }
});

/** POST /conversations/:id/read — body { storeId, lastMessageId } */
router.post('/conversations/:id/read', async (req, res) => {
  try {
    const { storeId, lastMessageId } = req.body;
    await chat.markRead(req.user, { storeId, conversationId: req.params.id, lastMessageId });
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, 'Gagal menandai sudah dibaca');
  }
});

/** POST /conversations/:id/messages — body { storeId, toId, text } */
router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const { storeId, toId, text } = req.body;
    res.json({
      success: true,
      data: await chat.sendReply(req.user, { storeId, conversationId: req.params.id, toId, text }),
    });
  } catch (err) {
    sendError(res, err, 'Gagal mengirim pesan');
  }
});

/** POST /conversations/:id/images — multipart: image, storeId, toId */
router.post('/conversations/:id/images', (req, res, next) => {
  // Run inline so a too-large file becomes a readable 400, not an HTML 500
  upload.single('image')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: 'Gambar maksimal 10 MB' });
    }
    if (err) return next(err);
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Gambar harus JPG, PNG, atau GIF, maksimal 10 MB' });
    }
    const { storeId, toId } = req.body;
    res.json({
      success: true,
      data: await chat.sendReply(req.user, {
        storeId,
        conversationId: req.params.id,
        toId,
        image: { buffer: req.file.buffer, filename: req.file.originalname, contentType: req.file.mimetype },
      }),
    });
  } catch (err) {
    sendError(res, err, 'Gagal mengirim gambar');
  }
});

/** GET /buyer-orders?storeId=&buyerId=&orderSns=a,b — orders beside the chat */
router.get('/buyer-orders', async (req, res) => {
  try {
    const { storeId, buyerId, orderSns } = req.query;
    res.json({
      success: true,
      data: await chat.buyerOrders(req.user, {
        storeId,
        buyerId,
        orderSns: String(orderSns || '').split(',').map(s => s.trim()),
      }),
    });
  } catch (err) {
    sendError(res, err, 'Gagal memuat pesanan pembeli');
  }
});

module.exports = router;
