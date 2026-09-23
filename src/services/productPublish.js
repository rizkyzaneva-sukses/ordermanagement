'use strict';

/**
 * productPublish.js — Salin Produk against Shopee and the database.
 *
 *   createDrafts      read the source item, store one draft per destination shop
 *   getFormContext    limits, attributes and channels of the destination shop
 *   searchBrands      brand lookup for the form
 *   validateDraft     everything that would make Publish fail, before it runs
 *   claimForPublish   DRAFT/FAILED → PUBLISHING, atomically
 *   runPublish        upload images → add_item → variations → list → catalogue
 *
 * The translation rules are in productCopy.js; this file only fetches, stores
 * and orders the calls.
 *
 * Publish is resumable by construction. Each step records that it finished
 * (uploadedImages, publishedItemId, publishSteps) before the next one starts, so
 * a retry after a failure — or after the worker died mid-way — picks up where it
 * stopped and never creates the same product on Shopee twice.
 */

const crypto = require('crypto');
const prisma = require('../prisma/client.js');
const shopeeService = require('./shopee.js');
const { ensureFreshToken } = require('./tokens.js');
const { buildListingRows, upsertListings } = require('./productSync.js');
const copy = require('./productCopy.js');

/** A PUBLISHING draft untouched this long is treated as abandoned. */
const STALE_PUBLISH_MS = 15 * 60 * 1000;

/** Photos are uploaded a couple at a time: fast enough, and polite to Shopee. */
const UPLOAD_CONCURRENCY = 2;

/** Largest image accepted from the form or downloaded from the source shop. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// ── Caches ────────────────────────────────────────────────────────────────────
//
// Limits, attribute trees and brand lists change rarely and are asked for every
// time a form opens. In memory, per process, and short-lived: stale for a few
// minutes is harmless, a lookup per keystroke is not.

const cache = new Map();

async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await load();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

// ── Access ────────────────────────────────────────────────────────────────────

/** Store ids a STAFF user may act on; null means unrestricted. */
async function allowedStoreIds(user) {
  if (user.role !== 'STAFF') return null;
  const rows = await prisma.storeAccess.findMany({ where: { userId: user.id }, select: { storeId: true } });
  return rows.map(r => r.storeId);
}

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

/**
 * Load a draft the user may act on, or throw 404/403.
 * A STAFF user needs access to the destination shop.
 */
async function loadDraftFor(user, draftId) {
  const draft = await prisma.productDraft.findUnique({
    where: { id: String(draftId) },
    include: {
      sourceStore: { select: { id: true, name: true } },
      targetStore: { select: { id: true, name: true, platform: true, isActive: true, needsReconnect: true } },
    },
  });
  if (!draft) throw httpError(404, 'Draf tidak ditemukan');
  const allowed = await allowedStoreIds(user);
  if (allowed && !allowed.includes(draft.targetStoreId)) throw httpError(403, 'Tidak punya akses ke toko tujuan draf ini');
  return draft;
}

/** True while a draft is legitimately being published by someone. */
function isPublishing(draft) {
  return draft.status === 'PUBLISHING'
    && draft.publishStartedAt
    && Date.now() - new Date(draft.publishStartedAt).getTime() < STALE_PUBLISH_MS;
}

/**
 * The status an operator should see. A PUBLISHING draft nobody has touched in
 * fifteen minutes died with its worker; showing it as still running forever
 * would leave the Publish button disabled with no way out.
 */
function effectiveStatus(draft) {
  if (draft.status === 'PUBLISHING' && !isPublishing(draft)) return 'FAILED';
  return draft.status;
}

// ── Reading the source ────────────────────────────────────────────────────────

async function fetchSnapshot(store, itemId) {
  const accessToken = await ensureFreshToken(store);
  const base = await shopeeService.getItemBaseInfo(accessToken, store.shopId, [itemId]);
  const item = base.response?.item_list?.[0];
  if (!item) throw httpError(404, `Produk ${itemId} tidak ditemukan di ${store.name} — mungkin sudah dihapus`);
  let models = null;
  if (item.has_model) {
    const res = await shopeeService.getModelList(accessToken, store.shopId, itemId);
    models = res.response || null;
  }
  return { item, models, fetchedAt: new Date().toISOString() };
}

/**
 * Salin Produk: one draft per destination shop, all from one fresh read of the
 * source item.
 *
 * @param {Object} user
 * @param {Object} input
 * @param {string[]} input.listingIds    - Selected rows; must all belong to one item
 * @param {string[]} input.targetStoreIds
 * @returns {Promise<{ drafts: Array, duplicates: Array }>}
 */
async function createDrafts(user, { listingIds, targetStoreIds }) {
  if (!Array.isArray(listingIds) || listingIds.length === 0) throw httpError(400, 'Pilih produk yang mau disalin');
  if (!Array.isArray(targetStoreIds) || targetStoreIds.length === 0) throw httpError(400, 'Pilih minimal satu toko tujuan');

  const allowed = await allowedStoreIds(user);

  const listings = await prisma.productListing.findMany({
    where: { id: { in: listingIds.map(String) }, ...(allowed ? { storeId: { in: allowed } } : {}) },
    select: { storeId: true, itemId: true, platform: true },
  });
  const items = new Set(listings.map(l => `${l.storeId}:${l.itemId}`));
  if (items.size === 0) throw httpError(404, 'Produk tidak ditemukan');
  if (items.size > 1) throw httpError(400, 'Salin Produk hanya untuk satu produk sekaligus — pilih varian dari satu produk saja');

  const { storeId: sourceStoreId, itemId } = listings[0];
  const sourceStore = await prisma.store.findUnique({ where: { id: sourceStoreId } });
  if (sourceStore.platform !== 'SHOPEE') throw httpError(400, 'Salin Produk baru mendukung Shopee');
  if (sourceStore.needsReconnect) throw httpError(400, `${sourceStore.name} perlu dihubungkan ulang dulu`);

  const targetIds = [...new Set(targetStoreIds.map(String))].filter(id => id !== sourceStoreId);
  if (targetIds.length === 0) throw httpError(400, 'Toko tujuan tidak boleh sama dengan toko asal');
  if (allowed && targetIds.some(id => !allowed.includes(id))) throw httpError(403, 'Tidak punya akses ke salah satu toko tujuan');

  const targets = await prisma.store.findMany({
    where: { id: { in: targetIds }, platform: 'SHOPEE', isActive: true },
    select: { id: true, name: true, needsReconnect: true },
  });
  if (targets.length !== targetIds.length) throw httpError(400, 'Ada toko tujuan yang tidak aktif atau bukan Shopee');
  const broken = targets.filter(t => t.needsReconnect);
  if (broken.length > 0) throw httpError(400, `Hubungkan ulang dulu: ${broken.map(t => t.name).join(', ')}`);

  let snapshot;
  try {
    snapshot = await fetchSnapshot(sourceStore, itemId);
  } catch (err) {
    if (err.status) throw err;
    throw httpError(502, `Gagal membaca produk asal dari Shopee: ${copy.explainShopeeError(err)}`);
  }
  const payload = copy.snapshotToPayload(snapshot);

  // Said, not refused: copying the same product to the same shop twice is
  // occasionally deliberate, and always worth a second look.
  const duplicates = await prisma.productDraft.findMany({
    where: { sourceStoreId, sourceItemId: itemId, targetStoreId: { in: targetIds }, status: { not: 'PUBLISHED' } },
    select: { id: true, targetStoreId: true, createdAt: true },
  });

  const drafts = [];
  for (const target of targets) {
    drafts.push(await prisma.productDraft.create({
      data: {
        sourceStoreId,
        sourceItemId: itemId,
        targetStoreId: target.id,
        payload,
        sourceSnapshot: snapshot,
        createdById: user.id,
      },
      select: { id: true, targetStoreId: true },
    }));
  }

  console.log(`[copy] ${sourceStore.name} item ${itemId} → ${targets.map(t => t.name).join(', ')} (${drafts.length} draf)`);

  return {
    drafts: drafts.map(d => ({ ...d, targetStoreName: targets.find(t => t.id === d.targetStoreId)?.name })),
    duplicates: duplicates.map(d => ({ ...d, targetStoreName: targets.find(t => t.id === d.targetStoreId)?.name })),
  };
}

// ── Form context ──────────────────────────────────────────────────────────────

const INPUT_TYPES = {
  1: 'select', 2: 'combo', 3: 'text', 4: 'multiselect', 5: 'multicombo',
  DROP_DOWN: 'select', SINGLE_DROP_DOWN: 'select',
  COMBO_BOX: 'combo', SINGLE_COMBO_BOX: 'combo',
  TEXT_FILED: 'text', TEXT_FIELD: 'text', FREE_TEXT_FILED: 'text',
  MULTIPLE_SELECT: 'multiselect', MULTI_DROP_DOWN: 'multiselect',
  MULTIPLE_SELECT_COMBO_BOX: 'multicombo', MULTI_COMBO_BOX: 'multicombo',
};

function localName(node, ...fields) {
  for (const f of fields) if (node?.[f]) return String(node[f]);
  const lang = Array.isArray(node?.multi_lang) ? node.multi_lang : [];
  return String((lang.find(l => l.language === 'id') || lang[0])?.value ?? '');
}

/**
 * get_attribute_tree, flattened for the form.
 *
 * Written defensively: this endpoint has not been seen answering with real data
 * yet (the probe only confirmed it answers), so every field has a fallback, and
 * an attribute that cannot be read is dropped rather than breaking the form.
 */
function normaliseAttributeTree(response, categoryId) {
  const list = Array.isArray(response?.list) ? response.list : [];
  const entry = list.find(e => Number(e.category_id) === Number(categoryId)) || list[0];
  const tree = entry?.attribute_tree || entry?.attribute_list || [];
  return tree.map((a) => {
    const info = a.attribute_info || a;
    const id = Number(a.attribute_id);
    if (!id) return null;
    return {
      attributeId: id,
      name: localName(a, 'display_attribute_name', 'original_attribute_name', 'name') || `Atribut ${id}`,
      mandatory: Boolean(a.mandatory ?? a.is_mandatory),
      inputType: INPUT_TYPES[info.input_type] || 'select',
      maxValues: Number(info.max_value_count) || null,
      units: Array.isArray(info.attribute_unit_list) ? info.attribute_unit_list.map(String) : [],
      values: (a.attribute_value_list || []).map(v => ({
        valueId: Number(v.value_id) || 0,
        name: localName(v, 'display_value_name', 'original_value_name', 'name'),
        unit: v.value_unit ? String(v.value_unit) : '',
      })).filter(v => v.valueId || v.name),
    };
  }).filter(Boolean);
}

/** Top-level channels (mask_channel_id 0) with the couriers inside each. */
function normaliseChannels(response) {
  const all = response?.logistics_channel_list || [];
  const top = all.filter(c => !Number(c.mask_channel_id));
  return top.map(c => ({
    channelId: Number(c.logistics_channel_id),
    name: String(c.logistics_channel_name ?? ''),
    enabled: Boolean(c.enabled),
    maxWeightKg: Number(c.weight_limit?.item_max_weight) || 0,
    couriers: all
      .filter(k => Number(k.mask_channel_id) === Number(c.logistics_channel_id))
      .map(k => ({ name: String(k.logistics_channel_name ?? ''), enabled: Boolean(k.enabled) })),
  }));
}

/**
 * What the Edit Produk form and the validator need from the destination shop.
 * Each lookup fails on its own: a form with no attribute list is still usable,
 * a form that refuses to open is not.
 */
async function getFormContext(draft) {
  const store = await prisma.store.findUnique({ where: { id: draft.targetStoreId } });
  const accessToken = await ensureFreshToken(store);
  const categoryId = draft.payload?.categoryId;
  const warnings = [];

  const [limitsRaw, attributes, channels, brandsHead] = await Promise.all([
    cached(`limits:${store.id}:${categoryId}`, 30 * 60_000, async () =>
      (await shopeeService.getItemLimit(accessToken, store.shopId, categoryId)).response || {})
      .catch((err) => { warnings.push(`Batas produk tidak terbaca: ${err.message}`); return {}; }),
    cached(`attrs:${categoryId}`, 30 * 60_000, async () =>
      normaliseAttributeTree((await shopeeService.getAttributeTree(accessToken, store.shopId, categoryId)).response, categoryId))
      .catch((err) => { warnings.push(`Daftar atribut tidak terbaca: ${err.message}`); return []; }),
    cached(`channels:${store.id}`, 10 * 60_000, async () =>
      normaliseChannels((await shopeeService.getChannelList(accessToken, store.shopId)).response))
      .catch((err) => { warnings.push(`Jasa kirim tidak terbaca: ${err.message}`); return null; }),
    cached(`brandhead:${categoryId}`, 6 * 60 * 60_000, async () =>
      (await shopeeService.getBrandList(accessToken, store.shopId, { categoryId, pageSize: 1 })).response || {})
      .catch(() => ({})),
  ]);

  return {
    limitsRaw,
    limits: copy.normaliseLimits(limitsRaw),
    attributes,
    channels,
    brandMandatory: Boolean(brandsHead?.is_mandatory),
    warnings,
  };
}

/**
 * Brands allowed in a category, filtered by name.
 *
 * get_brand_list has no search, so the whole list is paged in once per
 * category and filtered here. Capped, because a category can list thousands
 * and the operator only ever wants a handful.
 */
async function searchBrands(draft, query) {
  const store = await prisma.store.findUnique({ where: { id: draft.targetStoreId } });
  const categoryId = draft.payload?.categoryId;
  const all = await cached(`brands:${categoryId}`, 6 * 60 * 60_000, async () => {
    const accessToken = await ensureFreshToken(store);
    const out = [];
    let offset = 0;
    for (let page = 0; page < 50; page++) {
      const res = (await shopeeService.getBrandList(accessToken, store.shopId, { categoryId, offset, pageSize: 100 })).response || {};
      for (const b of res.brand_list || []) {
        out.push({ id: Number(b.brand_id), name: String(b.display_brand_name || b.original_brand_name || '') });
      }
      if (!res.has_next_page) break;
      offset = res.next_offset ?? offset + 100;
    }
    return out;
  });
  const q = String(query ?? '').trim().toLowerCase();
  return (q ? all.filter(b => b.name.toLowerCase().includes(q)) : all).slice(0, 50);
}

async function validateDraft(draft, context) {
  const ctx = context || await getFormContext(draft);
  const channelMap = ctx.channels ? new Map(ctx.channels.map(c => [c.channelId, c])) : null;
  return copy.validatePayload(draft.payload, {
    limits: ctx.limits,
    sourceName: draft.sourceSnapshot?.item?.item_name,
    mandatoryAttributeIds: ctx.attributes.filter(a => a.mandatory).map(a => a.attributeId),
    attributeNames: new Map(ctx.attributes.map(a => [a.attributeId, a.name])),
    brandMandatory: ctx.brandMandatory,
    channels: channelMap,
  });
}

// ── Images ────────────────────────────────────────────────────────────────────

function guessType(buffer, fallback = 'image/jpeg') {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  return fallback;
}

async function downloadImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('lebih dari 10 MB');
    return { buffer, contentType: res.headers.get('content-type') || guessType(buffer) };
  } finally {
    clearTimeout(timer);
  }
}

/** An image the operator uploads on the form goes straight to Shopee. */
async function uploadFormImage(buffer, { filename, contentType, scene }) {
  if (!buffer?.length) throw httpError(400, 'File gambar kosong');
  if (buffer.length > MAX_IMAGE_BYTES) throw httpError(400, 'Gambar maksimal 10 MB');
  const type = guessType(buffer, contentType);
  if (!['image/jpeg', 'image/png'].includes(type)) throw httpError(400, 'Format gambar harus JPG atau PNG');
  try {
    return await shopeeService.uploadImage(buffer, {
      filename: filename || (type === 'image/png' ? 'image.png' : 'image.jpg'),
      contentType: type,
      scene: scene === 'desc' ? 'desc' : 'normal',
    });
  } catch (err) {
    throw httpError(502, `Shopee menolak gambar: ${copy.explainShopeeError(err)}`);
  }
}

// ── Publish ───────────────────────────────────────────────────────────────────

/**
 * Take the draft for publishing, or return false if someone already has it.
 * One conditional update, so two clicks in two browsers make one job.
 */
async function claimForPublish(draftId) {
  const staleBefore = new Date(Date.now() - STALE_PUBLISH_MS);
  const res = await prisma.productDraft.updateMany({
    where: {
      id: draftId,
      OR: [
        { status: { in: ['DRAFT', 'FAILED'] } },
        { status: 'PUBLISHING', publishStartedAt: { lt: staleBefore } },
      ],
    },
    data: { status: 'PUBLISHING', publishStartedAt: new Date(), lastError: null, lastErrorRaw: null },
  });
  return res.count === 1;
}

function hashBody(body) {
  return crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
}

class StepError extends Error {
  constructor(step, cause) {
    super(cause?.message || String(cause));
    this.step = step;
    this.cause = cause;
  }
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof StepError ? err : new StepError(name, err);
  }
}

async function mapLimited(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * Publish one draft. Safe to call again after any failure.
 *
 * @param {string} draftId
 */
async function runPublish(draftId) {
  const draft = await prisma.productDraft.findUnique({
    where: { id: draftId },
    include: { targetStore: true },
  });
  if (!draft) return;
  if (draft.status !== 'PUBLISHING') {
    console.warn(`[publish] Draft ${draftId} is ${draft.status}, not PUBLISHING — skipped`);
    return;
  }

  const store = draft.targetStore;
  const payload = draft.payload;
  const uploaded = { ...(draft.uploadedImages || {}) };
  const steps = { ...(draft.publishSteps || {}) };
  const saveProgress = (data) => prisma.productDraft.update({
    where: { id: draftId },
    // Touching publishStartedAt is the heartbeat: a long upload is not stale.
    data: { ...data, publishStartedAt: new Date() },
  });

  console.log(`[publish] Draft ${draftId} → ${store.name}: "${payload.name}"`);

  try {
    if (!store.isActive || store.needsReconnect) {
      throw new StepError('Cek toko', new Error('Toko tujuan tidak aktif atau perlu dihubungkan ulang di Kelola Toko'));
    }
    const accessToken = await step('Cek toko', () => ensureFreshToken(store));

    // 1. Images from the source shop → this shop's media space
    const pending = copy.imagesToUpload(payload).filter(img => !uploaded[img.ref]);
    let done = 0;
    await mapLimited(pending, UPLOAD_CONCURRENCY, async (img) => {
      const label = `Unggah gambar ${img.url || img.sourceImageId}`;
      await step(label, async () => {
        if (!img.url) throw new Error('gambar ini tidak punya URL dari Shopee — ganti gambarnya di form');
        const { buffer, contentType } = await downloadImage(img.url);
        const { imageId } = await shopeeService.uploadImage(buffer, { contentType: guessType(buffer, contentType), scene: img.scene });
        uploaded[img.ref] = imageId;
        done += 1;
        await saveProgress({ uploadedImages: uploaded });
      });
    });
    if (pending.length) console.log(`[publish] Draft ${draftId}: ${done} gambar diunggah`);

    // 2. The item itself, unlisted
    const itemBody = await step('Siapkan data produk', () => copy.buildAddItemBody(payload, uploaded));
    let itemId = draft.publishedItemId;
    if (!itemId) {
      const res = await step('Buat produk (add_item)', async () => {
        try {
          return await shopeeService.addItem(accessToken, store.shopId, itemBody);
        } catch (err) {
          // If this shop's API will not take a status on create, the item is
          // made live straight away instead. Noted, so it is not a surprise.
          if (/item_status/i.test(err.shopeeMessage || err.message)) {
            steps.createdLive = true;
            const { item_status: _ignored, ...rest } = itemBody;
            return shopeeService.addItem(accessToken, store.shopId, rest);
          }
          throw err;
        }
      });
      itemId = String(res.response?.item_id ?? '');
      if (!itemId) throw new StepError('Buat produk (add_item)', new Error('Shopee tidak mengembalikan item_id'));
      steps.itemBodyHash = hashBody(itemBody);
      await saveProgress({ publishedItemId: itemId, publishSteps: steps });
      console.log(`[publish] Draft ${draftId}: item ${itemId} dibuat${steps.createdLive ? ' (langsung tayang)' : ' (UNLIST)'}`);
    } else if (steps.itemBodyHash !== hashBody(itemBody)) {
      // Edited after an earlier attempt created the item: bring it up to date
      // rather than publishing what the operator already changed.
      // Price and stock have their own endpoints and are not update_item fields;
      // on an item with variations they live on the models anyway.
      const { item_status: _s, category_id: _c, original_price: _p, seller_stock: _st, ...fields } = itemBody;
      await step('Perbarui produk (update_item)', () =>
        shopeeService.updateItem(accessToken, store.shopId, { ...fields, item_id: Number(itemId) }));
      steps.itemBodyHash = hashBody(itemBody);
      await saveProgress({ publishSteps: steps });
    }

    // 3. Variations
    if (payload.tiers?.length && !steps.tiersDone) {
      await step('Buat variasi (init_tier_variation)', async () => {
        // A lost response can leave the variations made on Shopee but unrecorded
        // here; asking first keeps a retry from failing on "already exists".
        const existing = await shopeeService.getModelList(accessToken, store.shopId, itemId).catch(() => null);
        if (!(existing?.response?.model?.length > 0)) {
          await shopeeService.initTierVariation(accessToken, store.shopId,
            copy.buildTierVariationBody(payload, itemId, uploaded));
        }
      });
      steps.tiersDone = true;
      await saveProgress({ publishSteps: steps });
    }

    // 4. On sale
    if (!steps.listed && !steps.createdLive) {
      await step('Tayangkan produk (unlist_item)', async () => {
        const reasonOf = (f) => f.failed_reason || f.fail_message || JSON.stringify(f);
        let res;
        try {
          res = await shopeeService.unlistItem(accessToken, store.shopId, [{ item_id: Number(itemId), unlist: false }]);
        } catch (err) {
          // "all failed" says nothing on its own. Shopee's per-item reason, and
          // the item's own status, are what tell an operator what to fix.
          const failure = err.shopeeResponse?.failure_list?.[0];
          const itemStatus = await shopeeService.getItemBaseInfo(accessToken, store.shopId, [itemId])
            .then(r => r.response?.item_list?.[0]?.item_status)
            .catch(() => null);
          const extra = [
            failure && reasonOf(failure),
            itemStatus && `status produk di Shopee: ${itemStatus}`,
          ].filter(Boolean).join('; ');
          if (extra) err.shopeeMessage = `${err.shopeeMessage || err.message} — ${extra}`;
          err.itemStatus = itemStatus;
          throw err;
        }
        const failure = res.response?.failure_list?.[0];
        if (failure) throw new Error(reasonOf(failure));
      });
    }
    steps.listed = true;
    await saveProgress({ publishSteps: steps });

    // 5. Into the catalogue, bound to the source's masters. The product is live
    // by now, so a failure here is reported without undoing the publish.
    let bindWarning = null;
    try {
      const base = await shopeeService.getItemBaseInfo(accessToken, store.shopId, [itemId]);
      const info = base.response?.item_list?.[0];
      const models = info?.has_model
        ? (await shopeeService.getModelList(accessToken, store.shopId, itemId)).response?.model || []
        : [];
      if (info) await upsertListings(store, buildListingRows(info, models));

      const sourceListings = await prisma.productListing.findMany({
        where: { storeId: draft.sourceStoreId, itemId: draft.sourceItemId },
        select: { modelId: true, productId: true },
      });
      const plan = copy.planListingBinding(payload, models, sourceListings);
      for (const b of plan) {
        await prisma.productListing.updateMany({
          where: { storeId: store.id, itemId, modelId: b.modelId, productId: null },
          data: { productId: b.productId },
        });
      }
      console.log(`[publish] Draft ${draftId}: ${plan.length} varian diikat ke master`);
    } catch (err) {
      bindWarning = `Produk sudah tayang, tapi gagal masuk katalog/diikat ke master: ${err.message}. Tekan "Tarik Katalog Toko Ini" lalu ikat manual.`;
      console.error(`[publish] Draft ${draftId}: ${bindWarning}`);
    }

    await prisma.productDraft.update({
      where: { id: draftId },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        publishSteps: steps,
        lastError: bindWarning,
        lastErrorRaw: null,
      },
    });
    console.log(`[publish] Draft ${draftId}: TERBIT sebagai item ${itemId}`);
  } catch (err) {
    const stepName = err instanceof StepError ? err.step : 'Publish';
    const cause = err instanceof StepError ? err.cause : err;
    const message = `${stepName}: ${copy.explainShopeeError(cause)}`;
    console.error(`[publish] Draft ${draftId} gagal — ${message}`);
    await prisma.productDraft.update({
      where: { id: draftId },
      data: {
        status: 'FAILED',
        uploadedImages: uploaded,
        publishSteps: steps,
        lastError: message,
        lastErrorRaw: {
          step: stepName,
          error: cause?.shopeeError ?? null,
          message: cause?.shopeeMessage ?? cause?.message ?? String(cause),
          requestId: cause?.requestId ?? null,
          path: cause?.path ?? null,
          itemStatus: cause?.itemStatus ?? null,
          response: cause?.shopeeResponse ?? null,
          at: new Date().toISOString(),
        },
      },
    }).catch((e) => console.error(`[publish] Draft ${draftId}: could not record failure: ${e.message}`));
  }
}

module.exports = {
  STALE_PUBLISH_MS,
  allowedStoreIds,
  loadDraftFor,
  effectiveStatus,
  isPublishing,
  createDrafts,
  getFormContext,
  searchBrands,
  validateDraft,
  uploadFormImage,
  claimForPublish,
  runPublish,
  httpError,
  // Exported for testing
  normaliseAttributeTree,
  normaliseChannels,
};
