'use strict';

/**
 * productCopy.js — the rules of "Salin Produk", with no I/O.
 *
 * A copy moves through three shapes:
 *
 *   Shopee's answer        get_item_base_info + get_model_list for the source item
 *        │  snapshotToPayload
 *   draft payload          what the Edit Produk form shows and saves
 *        │  buildAddItemBody / buildTierVariationBody
 *   Shopee's request       add_item + init_tier_variation for the destination shop
 *
 * Everything that can go wrong in translation lives here so it can be tested
 * against recorded responses without a database or a live shop. The calls
 * themselves are in productPublish.js.
 *
 * Field names follow what the probe of 17 Sep 2026 actually returned
 * (scripts/probe-product-write.js), not only the published docs.
 */

// ── Reading Shopee's answer ───────────────────────────────────────────────────

/** Price before any promotion. A copy must not inherit a flash-sale price. */
function readOriginalPrice(source) {
  const first = Array.isArray(source?.price_info) ? source.price_info[0] : null;
  const n = Number(first?.original_price ?? first?.current_price);
  return Number.isFinite(n) ? n : null;
}

/**
 * The stock a seller set, which is what a copy starts from.
 *
 * `seller_stock` rather than the available total: the total subtracts stock
 * reserved by unpaid orders in the source shop, which has nothing to do with the
 * destination.
 */
function readSellerStock(source) {
  const v2 = source?.stock_info_v2;
  const seller = Array.isArray(v2?.seller_stock) ? v2.seller_stock : [];
  if (seller.length > 0) {
    return seller.reduce((sum, s) => sum + (Number(s?.stock) || 0), 0);
  }
  const summary = Number(v2?.summary_info?.total_available_stock);
  if (Number.isFinite(summary)) return summary;
  const legacy = Array.isArray(source?.stock_info) ? source.stock_info : [];
  const first = legacy.find(s => s?.stock_type === 2) || legacy[0];
  const n = Number(first?.current_stock ?? first?.normal_stock);
  return Number.isFinite(n) ? n : 0;
}

/** Shopee weighs in kg, as a string ("0.3"); the form works in grams. */
function kgToGram(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
}

function gramToKg(gram) {
  return Math.round(Number(gram)) / 1000;
}

/** A dimension of all zeros is Shopee's way of saying "not set". */
function readDimension(dim) {
  const length = Number(dim?.package_length) || 0;
  const width = Number(dim?.package_width) || 0;
  const height = Number(dim?.package_height) || 0;
  if (!length && !width && !height) return null;
  return { length, width, height };
}

function firstImageUrl(image) {
  const urls = image?.image_url_list;
  if (Array.isArray(urls) && urls.length > 0) return String(urls[0]);
  return image?.image_url ? String(image.image_url) : null;
}

/**
 * Description as blocks when the item uses Shopee's extended (image) format,
 * or as one string when it does not. Zaneva's own items are extended.
 */
function readDescription(item) {
  const type = item?.description_type === 'extended' ? 'extended' : 'normal';
  if (type === 'normal') {
    return { descriptionType: 'normal', description: String(item?.description ?? ''), descriptionBlocks: [] };
  }

  const fields = item?.description_info?.extended_description?.field_list;
  const blocks = (Array.isArray(fields) ? fields : []).map((f) => {
    if (f?.field_type === 'image') {
      const info = f.image_info || {};
      return { type: 'image', url: info.image_url ? String(info.image_url) : null, sourceImageId: info.image_id ? String(info.image_id) : null };
    }
    return { type: 'text', text: String(f?.text ?? '') };
  }).filter(b => b.type === 'text' || b.url || b.sourceImageId);

  return { descriptionType: 'extended', description: '', descriptionBlocks: blocks };
}

/**
 * Stable key for a variation option. Models point at options by key, so an
 * option can be renamed or reordered on the form without losing its price,
 * stock, SKU — or its link back to the source variation's master.
 */
function optionKey(tierIndex, optionIndex) {
  return `t${tierIndex}o${optionIndex}`;
}

/**
 * Turn the source item into the draft the form edits.
 *
 * @param {Object} snapshot
 * @param {Object} snapshot.item   - One entry of get_item_base_info's item_list
 * @param {Object} [snapshot.models] - get_model_list's `response`, if the item has variations
 * @returns {Object} payload
 */
function snapshotToPayload({ item, models }) {
  if (!item) throw new Error('snapshot.item is required');

  const images = (item.image?.image_url_list || []).map((url, i) => ({
    url: String(url),
    sourceImageId: item.image?.image_id_list?.[i] ? String(item.image.image_id_list[i]) : null,
  }));

  const tiersRaw = Array.isArray(models?.tier_variation) ? models.tier_variation : [];
  const modelsRaw = Array.isArray(models?.model) ? models.model : [];
  const hasVariants = Boolean(item.has_model) && tiersRaw.length > 0 && modelsRaw.length > 0;

  const tiers = hasVariants
    ? tiersRaw.map((tier, t) => ({
      name: String(tier?.name ?? ''),
      options: (tier?.option_list || []).map((opt, o) => {
        const url = firstImageUrl(opt?.image);
        return {
          key: optionKey(t, o),
          name: String(opt?.option ?? ''),
          sourceName: String(opt?.option ?? ''),
          image: url ? { url, sourceImageId: opt.image?.image_id ? String(opt.image.image_id) : null } : null,
        };
      }),
    }))
    : [];

  const itemWeight = kgToGram(item.weight);
  const itemDimension = readDimension(item.dimension);

  const variantModels = hasVariants
    ? modelsRaw.map((m) => ({
      optionKeys: (m.tier_index || []).map((o, t) => optionKey(t, o)),
      sourceModelId: String(m.model_id),
      price: readOriginalPrice(m),
      stock: readSellerStock(m),
      sku: m.model_sku ? String(m.model_sku) : '',
      weightGram: kgToGram(m.weight),
      dimension: readDimension(m.dimension),
    }))
    : [];

  // Per-variation shipping only when the source genuinely varies. A model
  // weight equal to the item's is Shopee echoing the item back, not a choice.
  const perModelShipping = variantModels.some(m =>
    (m.weightGram !== null && m.weightGram !== itemWeight)
    || (m.dimension !== null && JSON.stringify(m.dimension) !== JSON.stringify(itemDimension)));

  const sizeChartId = Number(item.size_chart_id) || 0;
  const sizeChartRaw = item.size_chart ? String(item.size_chart) : '';
  let sizeChart = null;
  if (sizeChartId > 0) {
    // A template belongs to the shop that built it. Kept so the form can say
    // what the source used; Publish will not send another shop's template.
    sizeChart = { kind: 'template', templateId: sizeChartId, fromSource: true };
  } else if (sizeChartRaw) {
    sizeChart = /^https?:\/\//i.test(sizeChartRaw)
      ? { kind: 'image', url: sizeChartRaw, sourceImageId: null }
      : { kind: 'image', url: null, sourceImageId: sizeChartRaw };
  }

  return {
    name: String(item.item_name ?? ''),
    ...readDescription(item),
    categoryId: Number(item.category_id) || null,
    brand: {
      id: Number(item.brand?.brand_id) || 0,
      name: String(item.brand?.original_brand_name || item.brand?.display_brand_name || 'NoBrand'),
    },
    attributes: (item.attribute_list || []).map(a => ({
      attributeId: Number(a.attribute_id),
      name: String(a.original_attribute_name || a.display_attribute_name || ''),
      values: (a.attribute_value_list || []).map(v => ({
        valueId: Number(v.value_id) || 0,
        name: String(v.original_value_name ?? v.display_value_name ?? ''),
        unit: v.value_unit ? String(v.value_unit) : '',
      })),
    })),
    images,
    sizeChart,
    tiers,
    models: variantModels,
    itemSku: item.item_sku ? String(item.item_sku) : '',
    price: hasVariants ? null : readOriginalPrice(item),
    stock: hasVariants ? null : readSellerStock(item),
    weightGram: itemWeight,
    dimension: itemDimension,
    perModelShipping,
    logistics: (item.logistic_info || []).map(l => ({
      channelId: Number(l.logistic_id),
      name: String(l.logistic_name ?? ''),
      enabled: Boolean(l.enabled),
    })),
    condition: item.condition === 'USED' ? 'USED' : 'NEW',
    preOrder: {
      enabled: Boolean(item.pre_order?.is_pre_order),
      daysToShip: Number(item.pre_order?.days_to_ship) || null,
    },
    itemDangerous: Number(item.item_dangerous) || 0,
  };
}

// ── Variations ────────────────────────────────────────────────────────────────

/** Every combination of options, in Shopee's order (first tier outermost). */
function combinations(tiers) {
  return tiers.reduce(
    (acc, tier) => acc.flatMap(prefix => tier.options.map(opt => [...prefix, opt.key])),
    [[]],
  );
}

/** Position of each option key within its tier, as Shopee's tier_index. */
function tierIndexOf(tiers, optionKeys) {
  return optionKeys.map((key, t) => tiers[t]?.options.findIndex(o => o.key === key) ?? -1);
}

// ── Limits and requirements ───────────────────────────────────────────────────

/**
 * get_item_limit, flattened to what validation needs. Missing fields fall back
 * to the values the probe returned for Shopee Indonesia on 17 Sep 2026.
 */
function normaliseLimits(raw = {}) {
  const r = raw || {};
  const ext = r.extended_description_limit || {};
  return {
    nameMin: r.item_name_length_limit?.min_limit ?? 10,
    nameMax: r.item_name_length_limit?.max_limit ?? 255,
    descriptionMin: r.item_description_length_limit?.min_limit ?? 50,
    descriptionMax: r.item_description_length_limit?.max_limit ?? 5000,
    extendedTextMin: ext.description_text_length_min ?? 50,
    extendedTextMax: ext.description_text_length_max ?? 5000,
    extendedImageMin: ext.description_image_num_min ?? 1,
    extendedImageMax: ext.description_image_num_max ?? 12,
    imageMin: r.item_image_count_limit?.min_limit ?? 3,
    imageMax: r.item_image_count_limit?.max_limit ?? 9,
    tierNameMax: r.tier_variation_name_length_limit?.max_limit ?? 14,
    optionMax: r.tier_variation_option_length_limit?.max_limit ?? 20,
    priceMin: r.price_limit?.min_limit ?? 99,
    priceMax: r.price_limit?.max_limit ?? 1_000_000_000,
    stockMin: r.stock_limit?.min_limit ?? 0,
    stockMax: r.stock_limit?.max_limit ?? 10_000_000,
    daysToShipMin: r.dts_limit?.days_to_ship_limit?.min_limit ?? 3,
    daysToShipMax: r.dts_limit?.days_to_ship_limit?.max_limit ?? 30,
    nonPreOrderDaysToShip: r.dts_limit?.non_pre_order_days_to_ship ?? 2,
    weightMandatory: r.weight_limit?.weight_mandatory ?? true,
    sizeChartMandatory: Boolean(r.size_chart_limit?.size_chart_mandatory),
  };
}

/**
 * Shopee counts characters, not UTF-16 units — an emoji is one, not two.
 */
function charLength(s) {
  return [...String(s ?? '')].length;
}

/**
 * Everything that would make Publish fail, found before Publish is pressed.
 *
 * @param {Object} payload
 * @param {Object} ctx
 * @param {Object} ctx.limits           - normaliseLimits(...)
 * @param {string} ctx.sourceName       - The source item's name
 * @param {number[]} [ctx.mandatoryAttributeIds]
 * @param {boolean} [ctx.brandMandatory]
 * @param {Map<number, {enabled: boolean, maxWeightKg: number}>} [ctx.channels] - The destination shop's top-level channels
 * @returns {Array<{field: string, message: string}>}
 */
function validatePayload(payload, ctx) {
  const L = ctx.limits || normaliseLimits();
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const p = payload || {};

  // Name
  const name = String(p.name ?? '').trim();
  if (!name) add('name', 'Nama produk wajib diisi');
  else if (charLength(name) < L.nameMin || charLength(name) > L.nameMax) {
    add('name', `Nama produk harus ${L.nameMin}–${L.nameMax} karakter (sekarang ${charLength(name)})`);
  }
  if (name && ctx.sourceName && name === String(ctx.sourceName).trim()) {
    add('name', 'Nama produk tidak boleh sama persis dengan produk asal — ubah sedikit');
  }

  // Description
  if (p.descriptionType === 'extended') {
    const blocks = Array.isArray(p.descriptionBlocks) ? p.descriptionBlocks : [];
    const textLen = blocks.filter(b => b.type === 'text').reduce((n, b) => n + charLength(b.text), 0);
    const imageCount = blocks.filter(b => b.type === 'image').length;
    if (textLen < L.extendedTextMin || textLen > L.extendedTextMax) {
      add('description', `Teks deskripsi harus ${L.extendedTextMin}–${L.extendedTextMax} karakter (sekarang ${textLen})`);
    }
    if (imageCount < L.extendedImageMin || imageCount > L.extendedImageMax) {
      add('description', `Deskripsi bergambar butuh ${L.extendedImageMin}–${L.extendedImageMax} gambar (sekarang ${imageCount})`);
    }
  } else {
    const len = charLength(p.description);
    if (len < L.descriptionMin || len > L.descriptionMax) {
      add('description', `Deskripsi harus ${L.descriptionMin}–${L.descriptionMax} karakter (sekarang ${len})`);
    }
  }

  if (!p.categoryId) add('category', 'Kategori tidak terbaca dari produk asal');

  // Brand & attributes
  if (ctx.brandMandatory && !(Number(p.brand?.id) > 0)) add('brand', 'Merek wajib dipilih untuk kategori ini');
  const filled = new Set((p.attributes || [])
    .filter(a => (a.values || []).some(v => Number(v.valueId) > 0 || String(v.name ?? '').trim()))
    .map(a => Number(a.attributeId)));
  for (const id of ctx.mandatoryAttributeIds || []) {
    if (!filled.has(Number(id))) {
      add(`attribute:${id}`, `${ctx.attributeNames?.get?.(Number(id)) || `Atribut ${id}`} wajib diisi`);
    }
  }

  // Images
  const imageCount = (p.images || []).length;
  if (imageCount < L.imageMin || imageCount > L.imageMax) {
    add('images', `Foto produk harus ${L.imageMin}–${L.imageMax} (sekarang ${imageCount})`);
  }

  if (L.sizeChartMandatory && !(p.sizeChart && (
    (p.sizeChart.kind === 'image' && (p.sizeChart.imageId || p.sizeChart.url || p.sizeChart.sourceImageId))
    || (p.sizeChart.kind === 'template' && !p.sizeChart.fromSource && Number(p.sizeChart.templateId) > 0)
  ))) {
    add('sizeChart', p.sizeChart?.fromSource
      ? 'Bagan ukuran produk asal berupa template toko asal — unggah gambar bagan ukuran untuk toko ini'
      : 'Bagan ukuran wajib untuk kategori ini');
  }

  // Variations
  const tiers = Array.isArray(p.tiers) ? p.tiers : [];
  const models = Array.isArray(p.models) ? p.models : [];
  const checkMoney = (field, label, price, stock) => {
    const pr = Number(price);
    if (!Number.isFinite(pr) || pr < L.priceMin || pr > L.priceMax) {
      add(field, `${label}: harga harus Rp ${L.priceMin.toLocaleString('id-ID')}–Rp ${L.priceMax.toLocaleString('id-ID')}`);
    }
    const st = Number(stock);
    if (!Number.isInteger(st) || st < L.stockMin || st > L.stockMax) {
      add(field, `${label}: stok harus bilangan bulat ${L.stockMin}–${L.stockMax.toLocaleString('id-ID')}`);
    }
  };

  if (tiers.length > 2) add('tiers', 'Maksimal 2 variasi');

  if (tiers.length === 0) {
    checkMoney('price', 'Produk', p.price, p.stock);
  } else {
    tiers.forEach((tier, t) => {
      const label = `Variasi ${t + 1}`;
      const tn = String(tier.name ?? '').trim();
      if (!tn) add(`tier:${t}`, `${label}: nama wajib diisi`);
      else if (charLength(tn) > L.tierNameMax) add(`tier:${t}`, `${label}: nama maksimal ${L.tierNameMax} karakter`);
      if (!tier.options?.length) add(`tier:${t}`, `${label}: minimal satu pilihan`);
      const seen = new Set();
      for (const opt of tier.options || []) {
        const on = String(opt.name ?? '').trim();
        if (!on) add(`tier:${t}`, `${label}: ada pilihan yang namanya kosong`);
        else if (charLength(on) > L.optionMax) add(`tier:${t}`, `${label}: pilihan "${on}" lebih dari ${L.optionMax} karakter`);
        const k = on.toLowerCase();
        if (on && seen.has(k)) add(`tier:${t}`, `${label}: pilihan "${on}" dobel`);
        seen.add(k);
      }
    });

    // Shopee's option images are all-or-nothing on the first tier.
    const firstOptions = tiers[0]?.options || [];
    const withImage = firstOptions.filter(o => o.image && (o.image.imageId || o.image.url || o.image.sourceImageId)).length;
    if (withImage > 0 && withImage < firstOptions.length) {
      add('tier:0', 'Foto variasi harus diisi untuk semua pilihan, atau dikosongkan semua');
    }

    const expected = combinations(tiers).map(keys => keys.join('|'));
    const actual = models.map(m => (m.optionKeys || []).join('|'));
    const missing = expected.filter(k => !actual.includes(k));
    if (missing.length > 0 || actual.length !== expected.length || new Set(actual).size !== actual.length) {
      add('models', 'Daftar varian tidak cocok dengan pilihan variasi — muat ulang form');
    }

    const nameOf = (m) => (m.optionKeys || [])
      .map((key, t) => tiers[t]?.options.find(o => o.key === key)?.name ?? '?').join(' / ');
    for (const m of models) {
      checkMoney('models', nameOf(m), m.price, m.stock);
      if (p.perModelShipping && !(Number(m.weightGram) > 0)) add('models', `${nameOf(m)}: berat wajib diisi`);
    }
  }

  // Shipping
  const heaviestGram = p.perModelShipping && models.length > 0
    ? Math.max(...models.map(m => Number(m.weightGram) || 0))
    : Number(p.weightGram) || 0;
  if (L.weightMandatory && !(Number(p.weightGram) > 0) && !(p.perModelShipping && heaviestGram > 0)) {
    add('weight', 'Berat wajib diisi');
  }

  const chosen = (p.logistics || []).filter(l => l.enabled);
  if (chosen.length === 0) add('logistics', 'Pilih minimal satu jasa kirim');
  if (ctx.channels) {
    for (const l of chosen) {
      const ch = ctx.channels.get(Number(l.channelId));
      if (!ch || !ch.enabled) {
        add('logistics', `Jasa kirim "${l.name || l.channelId}" tidak aktif di toko ini`);
      } else if (ch.maxWeightKg > 0 && heaviestGram > ch.maxWeightKg * 1000) {
        add('logistics', `Berat melebihi batas ${l.name || ch.name} (maks ${(ch.maxWeightKg * 1000).toLocaleString('id-ID')} g)`);
      }
    }
  }

  if (p.preOrder?.enabled) {
    const d = Number(p.preOrder.daysToShip);
    if (!Number.isInteger(d) || d < L.daysToShipMin || d > L.daysToShipMax) {
      add('preOrder', `Pre-order harus ${L.daysToShipMin}–${L.daysToShipMax} hari`);
    }
  }

  return errors;
}

// ── Building Shopee's request ─────────────────────────────────────────────────

/**
 * Every image a Publish has to have an id for, with the upload scene each needs.
 *
 * `ref` is the key uploadedImages is stored under: the source URL, or the
 * source image id when Shopee gave no URL.
 *
 * @returns {Array<{ref: string, url: string|null, scene: 'normal'|'desc'}>}
 */
function imagesToUpload(payload) {
  const out = [];
  const seen = new Set();
  const push = (img, scene) => {
    if (!img || img.imageId) return; // uploaded straight from the form already
    const ref = img.url || img.sourceImageId;
    if (!ref) return;
    const key = `${scene}:${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ref: key, url: img.url || null, sourceImageId: img.sourceImageId || null, scene });
  };

  for (const img of payload.images || []) push(img, 'normal');
  for (const opt of payload.tiers?.[0]?.options || []) push(opt.image, 'normal');
  if (payload.descriptionType === 'extended') {
    for (const b of payload.descriptionBlocks || []) if (b.type === 'image') push(b, 'desc');
  }
  if (payload.sizeChart?.kind === 'image') push(payload.sizeChart, 'desc');
  return out;
}

/** The image id to send for one image reference, or throw naming which one. */
function resolveImageId(img, scene, uploaded, label) {
  if (img?.imageId) return String(img.imageId);
  const ref = img?.url || img?.sourceImageId;
  const id = ref ? uploaded?.[`${scene}:${ref}`] : null;
  if (!id) throw new Error(`${label} belum terunggah ke Shopee`);
  return String(id);
}

/**
 * add_item body. The item is created UNLIST: if the variations step after it
 * fails, a half-built product must not be on sale.
 */
function buildAddItemBody(payload, uploaded) {
  const p = payload;
  const hasVariants = (p.tiers || []).length > 0;

  const price = hasVariants
    ? Math.min(...p.models.map(m => Number(m.price)))
    : Number(p.price);
  const stock = hasVariants
    ? p.models.reduce((n, m) => n + (Number(m.stock) || 0), 0)
    : Number(p.stock) || 0;
  // Shopee wants an item weight even when variations carry their own.
  const weightGram = Number(p.weightGram) > 0
    ? Number(p.weightGram)
    : Math.max(0, ...(p.models || []).map(m => Number(m.weightGram) || 0));

  const body = {
    item_name: String(p.name).trim(),
    category_id: Number(p.categoryId),
    original_price: price,
    seller_stock: [{ stock }],
    weight: gramToKg(weightGram),
    image: {
      image_id_list: (p.images || []).map((img, i) => resolveImageId(img, 'normal', uploaded, `Foto ${i + 1}`)),
    },
    logistic_info: (p.logistics || [])
      .filter(l => l.enabled)
      .map(l => ({ logistic_id: Number(l.channelId), enabled: true, is_free: false })),
    brand: {
      brand_id: Number(p.brand?.id) || 0,
      original_brand_name: Number(p.brand?.id) > 0 ? String(p.brand.name) : 'NoBrand',
    },
    attribute_list: (p.attributes || [])
      .map(a => ({
        attribute_id: Number(a.attributeId),
        attribute_value_list: (a.values || [])
          .filter(v => Number(v.valueId) > 0 || String(v.name ?? '').trim())
          .map(v => {
            const out = { value_id: Number(v.valueId) || 0 };
            // A free-text value has no id; Shopee needs the text instead.
            if (!(Number(v.valueId) > 0) || v.name) out.original_value_name = String(v.name ?? '');
            if (v.unit) out.value_unit = String(v.unit);
            return out;
          }),
      }))
      .filter(a => a.attribute_value_list.length > 0),
    condition: p.condition === 'USED' ? 'USED' : 'NEW',
    item_status: 'UNLIST',
    item_dangerous: Number(p.itemDangerous) || 0,
    description_type: p.descriptionType === 'extended' ? 'extended' : 'normal',
  };

  if (p.itemSku) body.item_sku = String(p.itemSku);

  if (p.dimension && (p.dimension.length || p.dimension.width || p.dimension.height)) {
    body.dimension = {
      package_length: Math.round(Number(p.dimension.length) || 0),
      package_width: Math.round(Number(p.dimension.width) || 0),
      package_height: Math.round(Number(p.dimension.height) || 0),
    };
  }

  if (p.preOrder?.enabled) {
    body.pre_order = { is_pre_order: true, days_to_ship: Number(p.preOrder.daysToShip) };
  }

  if (body.description_type === 'extended') {
    let imageNo = 0;
    body.description_info = {
      extended_description: {
        field_list: (p.descriptionBlocks || []).map((b) => {
          if (b.type === 'image') {
            imageNo += 1;
            return { field_type: 'image', image_info: { image_id: resolveImageId(b, 'desc', uploaded, `Gambar deskripsi ${imageNo}`) } };
          }
          return { field_type: 'text', text: String(b.text ?? '') };
        }),
      },
    };
  } else {
    body.description = String(p.description ?? '');
  }

  if (p.sizeChart?.kind === 'image') {
    body.size_chart_info = { size_chart: resolveImageId(p.sizeChart, 'desc', uploaded, 'Bagan ukuran') };
  } else if (p.sizeChart?.kind === 'template' && !p.sizeChart.fromSource && Number(p.sizeChart.templateId) > 0) {
    body.size_chart_info = { size_chart_id: Number(p.sizeChart.templateId) };
  }

  return body;
}

/** init_tier_variation body for an item created by buildAddItemBody. */
function buildTierVariationBody(payload, itemId, uploaded) {
  const p = payload;
  return {
    item_id: Number(itemId),
    tier_variation: p.tiers.map((tier, t) => ({
      name: String(tier.name).trim(),
      option_list: tier.options.map((opt) => {
        const out = { option: String(opt.name).trim() };
        if (t === 0 && opt.image) {
          out.image = { image_id: resolveImageId(opt.image, 'normal', uploaded, `Foto variasi "${opt.name}"`) };
        }
        return out;
      }),
    })),
    model: p.models.map((m) => {
      const out = {
        tier_index: tierIndexOf(p.tiers, m.optionKeys),
        original_price: Number(m.price),
        seller_stock: [{ stock: Number(m.stock) || 0 }],
      };
      if (m.sku) out.model_sku = String(m.sku);
      if (p.perModelShipping) {
        if (Number(m.weightGram) > 0) out.weight = gramToKg(m.weightGram);
        if (m.dimension && (m.dimension.length || m.dimension.width || m.dimension.height)) {
          out.dimension = {
            package_length: Math.round(Number(m.dimension.length) || 0),
            package_width: Math.round(Number(m.dimension.width) || 0),
            package_height: Math.round(Number(m.dimension.height) || 0),
          };
        }
      }
      return out;
    }),
  };
}

// ── After Publish ─────────────────────────────────────────────────────────────

/**
 * Which new listings inherit which master.
 *
 * A new variation is matched to the payload model at the same tier position,
 * and through it to the source variation it was copied from. Options added on
 * the form have no source, so they stay unbound — an operator binds those.
 *
 * @param {Object} payload
 * @param {Array<{model_id: number|string, tier_index: number[]}>} newModels - Empty for an item without variations
 * @param {Array<{modelId: string, productId: string|null}>} sourceListings - The source item's listings
 * @returns {Array<{modelId: string, productId: string}>}
 */
function planListingBinding(payload, newModels, sourceListings) {
  const productBySourceModel = new Map(
    sourceListings.filter(l => l.productId).map(l => [String(l.modelId ?? ''), l.productId]),
  );

  if (!(payload.tiers || []).length) {
    const productId = productBySourceModel.get('');
    return productId ? [{ modelId: '', productId }] : [];
  }

  const byTierIndex = new Map(
    payload.models.map(m => [tierIndexOf(payload.tiers, m.optionKeys).join(','), m]),
  );

  const plan = [];
  for (const nm of newModels) {
    const m = byTierIndex.get((nm.tier_index || []).join(','));
    if (!m?.sourceModelId) continue;
    const productId = productBySourceModel.get(String(m.sourceModelId));
    if (productId) plan.push({ modelId: String(nm.model_id), productId });
  }
  return plan;
}

/**
 * Shopee's error as a sentence an operator can act on. Unknown errors are
 * quoted as they are rather than hidden behind "tidak diketahui" — the raw text
 * is what gets a fix.
 */
function explainShopeeError(err) {
  const code = String(err?.shopeeError || '');
  const msg = String(err?.shopeeMessage || err?.message || '');
  const hints = [
    [/error_auth|invalid_access_token|invalid_acceess_token/i, 'Token toko tidak berlaku — hubungkan ulang toko di Kelola Toko'],
    [/duplicate|same name|similar/i, 'Shopee menganggap produk ini duplikat — ubah nama atau foto utama'],
    [/image/i, 'Ada foto yang ditolak Shopee'],
    [/brand/i, 'Merek ditolak Shopee untuk kategori ini'],
    [/attribute/i, 'Ada atribut yang ditolak Shopee'],
    [/logistic|channel/i, 'Jasa kirim ditolak Shopee'],
    [/size_chart|size chart/i, 'Bagan ukuran ditolak Shopee'],
    [/weight|dimension/i, 'Berat atau ukuran paket ditolak Shopee'],
    [/price/i, 'Harga ditolak Shopee'],
    [/item_name|name/i, 'Nama produk ditolak Shopee'],
  ];
  const hint = hints.find(([re]) => re.test(`${code} ${msg}`))?.[1];
  const quoted = code ? `${code}: ${err?.shopeeMessage || msg}` : msg;
  return hint ? `${hint} (${quoted})` : quoted;
}

module.exports = {
  snapshotToPayload,
  validatePayload,
  normaliseLimits,
  imagesToUpload,
  buildAddItemBody,
  buildTierVariationBody,
  planListingBinding,
  explainShopeeError,
  combinations,
  tierIndexOf,
  readOriginalPrice,
  readSellerStock,
  kgToGram,
  charLength,
};
