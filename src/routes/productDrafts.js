'use strict';

/**
 * productDrafts.js — Salin Produk: drafts from copy to publish.
 *
 * Mounted at /api/products/drafts. See PRD-salin-produk.md for the flow and
 * services/productPublish.js for what each step does against Shopee.
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const prisma = require('../prisma/client');
const { authenticate } = require('../middleware/auth');
const { productPublishQueue, hasQueueWorkers } = require('../services/queue');
const publish = require('../services/productPublish');
const { charLength, snapshotToPayload } = require('../services/productCopy');

router.use(authenticate);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const MAX_LIMIT = 100;

function sendError(res, err, fallback) {
  if (err.status) return res.status(err.status).json({ success: false, error: err.message, ...(err.errors ? { errors: err.errors } : {}) });
  console.error(`[drafts] ${fallback}:`, err);
  return res.status(500).json({ success: false, error: fallback });
}

/** A row for the Draf tab: enough to show and expand, not the whole form. */
function summarise(draft) {
  const p = draft.payload || {};
  const tiers = Array.isArray(p.tiers) ? p.tiers : [];
  const models = Array.isArray(p.models) ? p.models : [];
  const firstImage = (p.images || [])[0];

  const variants = tiers.length === 0 ? [] : models.map(m => ({
    name: (m.optionKeys || []).map((key, t) => tiers[t]?.options?.find(o => o.key === key)?.name ?? '?').join(' / '),
    price: m.price,
    stock: m.stock,
    sku: m.sku || '',
  }));
  const prices = tiers.length ? models.map(m => Number(m.price)).filter(Number.isFinite) : [Number(p.price)].filter(Number.isFinite);

  return {
    id: draft.id,
    status: publish.effectiveStatus(draft),
    name: p.name || '',
    imageUrl: firstImage?.url || null,
    itemSku: p.itemSku || '',
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    stockTotal: tiers.length ? models.reduce((n, m) => n + (Number(m.stock) || 0), 0) : (Number(p.stock) || 0),
    variants,
    sourceStore: draft.sourceStore,
    sourceItemId: draft.sourceItemId,
    targetStore: draft.targetStore,
    publishedItemId: draft.publishedItemId,
    lastError: draft.lastError,
    lastErrorRaw: draft.lastErrorRaw,
    publishedAt: draft.publishedAt,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

async function scopeWhere(user, query = {}) {
  const where = {};
  const allowed = await publish.allowedStoreIds(user);
  if (allowed) where.targetStoreId = { in: allowed };
  if (query.storeId) {
    if (allowed && !allowed.includes(String(query.storeId))) return null;
    where.targetStoreId = String(query.storeId);
  }
  return where;
}

/**
 * GET /summary — how many drafts are waiting, for the tab label.
 * Query: storeId
 */
router.get('/summary', async (req, res) => {
  try {
    const where = await scopeWhere(req.user, req.query);
    if (!where) return res.json({ success: true, data: { open: 0 } });
    const open = await prisma.productDraft.count({ where: { ...where, status: { not: 'PUBLISHED' } } });
    return res.json({ success: true, data: { open } });
  } catch (err) {
    return sendError(res, err, 'Gagal memuat jumlah draf');
  }
});

/**
 * GET / — the Draf tab.
 * Query: page, limit, storeId (destination), status, search
 */
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const where = await scopeWhere(req.user, req.query);
    if (!where) return res.json({ success: true, data: { drafts: [], total: 0, page, limit, totalPages: 0 } });

    const status = String(req.query.status || '');
    if (status === 'OPEN') where.status = { not: 'PUBLISHED' };
    else if (['DRAFT', 'PUBLISHING', 'PUBLISHED', 'FAILED'].includes(status)) where.status = status;

    if (req.query.search) {
      // Prisma's JSON filters cannot match case-insensitively, and an operator
      // typing "zora" expects "Zaneva - Zora Cap".
      const hits = await prisma.$queryRaw`
        SELECT id FROM product_drafts WHERE payload->>'name' ILIKE ${`%${String(req.query.search)}%`}`;
      where.id = { in: hits.map(h => h.id) };
    }

    const [rows, total] = await Promise.all([
      prisma.productDraft.findMany({
        where,
        include: {
          sourceStore: { select: { id: true, name: true } },
          targetStore: { select: { id: true, name: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.productDraft.count({ where }),
    ]);

    return res.json({
      success: true,
      data: { drafts: rows.map(summarise), total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return sendError(res, err, 'Gagal memuat draf');
  }
});

/**
 * POST / — Salin Produk.
 * Body: { listingIds[], targetStoreIds[] }
 */
router.post('/', async (req, res) => {
  try {
    const result = await publish.createDrafts(req.user, {
      listingIds: req.body?.listingIds,
      targetStoreIds: req.body?.targetStoreIds,
    });
    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    return sendError(res, err, 'Gagal menyalin produk');
  }
});

/** GET /:id — the full draft, for the Edit Produk form. */
router.get('/:id', async (req, res) => {
  try {
    const draft = await publish.loadDraftFor(req.user, req.params.id);
    const snapshotItem = draft.sourceSnapshot?.item || {};
    return res.json({
      success: true,
      data: {
        ...summarise(draft),
        payload: draft.payload,
        editable: ['DRAFT', 'FAILED'].includes(publish.effectiveStatus(draft)),
        source: {
          name: snapshotItem.item_name || '',
          // Which source channels and size chart the copy started from, so the
          // form can say what did not carry over.
          logistics: (snapshotItem.logistic_info || []).map(l => ({ channelId: l.logistic_id, name: l.logistic_name, enabled: l.enabled })),
        },
        itemAlreadyCreated: Boolean(draft.publishedItemId) && draft.status !== 'PUBLISHED',
      },
    });
  } catch (err) {
    return sendError(res, err, 'Gagal memuat draf');
  }
});

/** GET /:id/form-options — limits, attributes, channels of the destination shop, plus current problems. */
router.get('/:id/form-options', async (req, res) => {
  try {
    const draft = await publish.loadDraftFor(req.user, req.params.id);
    const context = await publish.getFormContext(draft);
    const errors = await publish.validateDraft(draft, context);
    const { limitsRaw: _raw, ...rest } = context;
    return res.json({ success: true, data: { ...rest, errors } });
  } catch (err) {
    return sendError(res, err, 'Gagal memuat pilihan form');
  }
});

/** GET /:id/brands?q= */
router.get('/:id/brands', async (req, res) => {
  try {
    const draft = await publish.loadDraftFor(req.user, req.params.id);
    const brands = await publish.searchBrands(draft, req.query.q);
    return res.json({ success: true, data: { brands } });
  } catch (err) {
    return sendError(res, err, 'Gagal memuat daftar merek');
  }
});

/**
 * Keep what the form may not change: the category (attributes depend on it)
 * and each variation's link to its source (masters depend on it). A payload
 * arriving from a browser is a request, not a trusted object.
 */
function sanitisePayload(incoming, draft) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw publish.httpError(400, 'payload tidak valid');
  }
  // Checked against the source as copied, not the last save: a link the form
  // dropped (say, a variation removed and added back) must still be restorable.
  const original = snapshotToPayload(draft.sourceSnapshot);
  const knownSourceModels = new Set(original.models.map(m => m.sourceModelId));
  const knownSourceOptions = new Map();
  original.tiers.forEach(t => t.options.forEach(o => knownSourceOptions.set(o.key, o.sourceName)));

  const tiers = Array.isArray(incoming.tiers) ? incoming.tiers : [];
  const models = Array.isArray(incoming.models) ? incoming.models : [];
  if (tiers.length > 2) throw publish.httpError(400, 'Maksimal 2 variasi');
  if (models.length > 400) throw publish.httpError(400, 'Terlalu banyak varian');
  if (charLength(incoming.name) > 1000) throw publish.httpError(400, 'Nama terlalu panjang');

  return {
    ...incoming,
    categoryId: original.categoryId,
    tiers: tiers.map(t => ({
      ...t,
      options: (Array.isArray(t.options) ? t.options : []).map(o => ({
        ...o,
        key: String(o.key),
        sourceName: knownSourceOptions.has(String(o.key)) ? knownSourceOptions.get(String(o.key)) : null,
      })),
    })),
    models: models.map(m => ({
      ...m,
      optionKeys: (Array.isArray(m.optionKeys) ? m.optionKeys : []).map(String),
      sourceModelId: knownSourceModels.has(m.sourceModelId) ? m.sourceModelId : null,
    })),
  };
}

/** PATCH /:id — Simpan Draf. Body: { payload } */
router.patch('/:id', async (req, res) => {
  try {
    const draft = await publish.loadDraftFor(req.user, req.params.id);
    const status = publish.effectiveStatus(draft);
    if (!['DRAFT', 'FAILED'].includes(status)) {
      return res.status(409).json({ success: false, error: status === 'PUBLISHED' ? 'Draf sudah terbit' : 'Draf sedang dipublish' });
    }
    const payload = sanitisePayload(req.body?.payload, draft);
    // Conditional on the status read above, so a Publish that started a moment
    // ago is not handed a payload it did not validate.
    const result = await prisma.productDraft.updateMany({
      where: { id: draft.id, status: draft.status, updatedAt: draft.updatedAt },
      data: { payload },
    });
    if (result.count === 0) {
      return res.status(409).json({ success: false, error: 'Draf berubah di tempat lain (mungkin sedang dipublish) — muat ulang form' });
    }
    return res.json({ success: true, data: { saved: true } });
  } catch (err) {
    return sendError(res, err, 'Gagal menyimpan draf');
  }
});

/** POST /:id/images — upload one image to Shopee. multipart: image, scene=normal|desc */
router.post('/:id/images', upload.single('image'), async (req, res) => {
  try {
    await publish.loadDraftFor(req.user, req.params.id);
    if (!req.file) return res.status(400).json({ success: false, error: 'File gambar wajib dikirim (field "image")' });
    const result = await publish.uploadFormImage(req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      scene: req.body?.scene,
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, error: 'Gambar maksimal 10 MB' });
    return sendError(res, err, 'Gagal mengunggah gambar');
  }
});

/**
 * POST /:id/publish
 *
 * Validates against the destination shop first and answers 400 with the list
 * of problems, so the form can point at them. Otherwise claims the draft and
 * hands it to the worker (or runs it here if no worker is listening).
 */
router.post('/:id/publish', async (req, res) => {
  try {
    const draft = await publish.loadDraftFor(req.user, req.params.id);
    const status = publish.effectiveStatus(draft);
    if (status === 'PUBLISHED') return res.status(409).json({ success: false, error: 'Draf sudah terbit' });
    if (status === 'PUBLISHING') return res.status(409).json({ success: false, error: 'Draf sedang dipublish' });
    if (!draft.targetStore.isActive || draft.targetStore.needsReconnect) {
      return res.status(400).json({ success: false, error: `${draft.targetStore.name} perlu dihubungkan ulang di Kelola Toko` });
    }

    const errors = await publish.validateDraft(draft);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: `${errors.length} hal perlu diperbaiki sebelum Publish`, errors });
    }

    if (!(await publish.claimForPublish(draft.id))) {
      return res.status(409).json({ success: false, error: 'Draf sedang dipublish oleh orang lain' });
    }

    let mode = 'queue';
    if (await hasQueueWorkers(productPublishQueue)) {
      await productPublishQueue.add('publish', { draftId: draft.id }, {
        // No automatic retry: a failed Publish is shown to the operator, who
        // fixes the draft and presses again. The steps already done are kept.
        attempts: 1,
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 7 * 86400 },
      });
    } else {
      mode = 'inline';
      console.warn(`[drafts] No product-publish worker — publishing draft ${draft.id} in the API process`);
      setImmediate(() => {
        publish.runPublish(draft.id).catch(e => console.error(`[drafts] Inline publish ${draft.id} crashed:`, e));
      });
    }

    return res.status(202).json({ success: true, data: { status: 'PUBLISHING', mode } });
  } catch (err) {
    return sendError(res, err, 'Gagal memulai Publish');
  }
});

/** DELETE /:id — Hapus Draf. The item on Shopee, if one was made, is left alone. */
router.delete('/:id', async (req, res) => {
  try {
    const draft = await publish.loadDraftFor(req.user, req.params.id);
    if (publish.isPublishing(draft)) {
      return res.status(409).json({ success: false, error: 'Draf sedang dipublish — tunggu selesai' });
    }
    await prisma.productDraft.delete({ where: { id: draft.id } });
    return res.json({
      success: true,
      data: { deleted: true, leftOnShopee: draft.status !== 'PUBLISHED' ? draft.publishedItemId : null },
    });
  } catch (err) {
    return sendError(res, err, 'Gagal menghapus draf');
  }
});

module.exports = router;
