'use strict';

/**
 * chat.js — the Shopee chat inbox: reading conversations and replying.
 *
 * Conversations are read live from Shopee rather than copied: Shopee already
 * keeps them, and a copy would need its own sync and would drift. What is kept
 * locally is only what Shopee cannot know — which operator sent each reply
 * (`ChatReply`) — and the link from a buyer to their orders (`Order.buyerUserId`).
 *
 * Replies only. Shopee's chat permission forbids proactive order updates,
 * broadcasts and chatbot replies; building any of them risks the permission
 * being withdrawn for the whole app.
 */

const prisma = require('../prisma/client.js');
const shopeeService = require('./shopee.js');
const { ensureFreshToken } = require('./tokens.js');
const { mapWithConcurrency, CALL_CONCURRENCY } = require('./syncDirect.js');

/** Shopee's own limit on one text message. */
const MAX_TEXT_LENGTH = 600;

function fail(statusCode, message, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

/**
 * Shopee's answer when the app has no chat permission.
 *
 * Told apart from every other failure because it is not something retrying or
 * reconnecting fixes — the permission is granted by Shopee, per app.
 */
function isPermissionError(err) {
  const code = `${err?.shopeeError || ''} ${err?.shopeeMessage || ''}`.toLowerCase();
  return /permission|no_access|not_authori[sz]ed|access_denied|unauthori[sz]ed/.test(code);
}

/** What the operator should read for the send errors Shopee documents. */
const SEND_ERRORS = {
  user_is_forbidden: 'Pembeli ini tidak bisa dihubungi: Shopee hanya mengizinkan membalas pembeli yang chat dalam 7 hari terakhir, memesan dalam 30 hari, atau punya retur/refund yang belum selesai.',
  reach_5_message_limit: 'Sudah 5 pesan terkirim tanpa balasan — Shopee menahan pesan berikutnya sampai pembeli membalas.',
  message_too_long: `Pesan terlalu panjang — maksimal ${MAX_TEXT_LENGTH} karakter.`,
  message_is_censored: 'Pesan ditolak Shopee karena mengandung kata yang dilarang.',
  error_business: 'Pesan ditolak Shopee karena isinya sama dengan pesan sebelumnya. Pesan berulang bisa menurunkan performa toko.',
  exceed_send_limitaion: 'Terlalu banyak pesan dalam waktu singkat — tunggu sebentar lalu coba lagi.',
  block_by_internal_safety_strategies: 'Pesan diblokir sistem keamanan Shopee.',
  error_blocked: 'Pembeli ini memblokir toko.',
  error_sender_block_receiver: 'Toko memblokir pembeli ini — buka blokir di Seller Centre dulu.',
  assigned_to_subaccount: 'Percakapan ini sedang ditangani sub-akun di Shopee — balas dari sub-akun tersebut.',
  shop_bound_subaccount: 'Chat toko ini dibagi ke sub-akun di Shopee. Matikan pembagian chat di platform sub-akun agar bisa membalas dari OrderPro.',
};

/** Rethrow a Shopee error with a status and a message fit for the operator. */
function translate(err, fallback) {
  if (isPermissionError(err)) {
    return fail(403, 'Akses Chat API belum dibuka Shopee untuk aplikasi ini.', 'CHAT_NOT_ENABLED');
  }
  if (err.shopeeError && SEND_ERRORS[err.shopeeError]) {
    return fail(422, SEND_ERRORS[err.shopeeError], err.shopeeError);
  }
  if (err.statusCode) return err;
  return fail(502, `${fallback}: ${err.shopeeMessage || err.message}`);
}

/**
 * The Shopee stores this user may chat for.
 *
 * Same rule as orders: STAFF see the stores they were given, everyone else
 * sees all of them.
 *
 * @param {{ id: string, role: string }} user
 * @returns {Promise<Object[]>}
 */
async function storesFor(user) {
  const where = { platform: 'SHOPEE', isActive: true };
  if (user.role === 'STAFF') {
    const access = await prisma.storeAccess.findMany({ where: { userId: user.id }, select: { storeId: true } });
    where.id = { in: access.map(a => a.storeId) };
  }
  return prisma.store.findMany({ where, orderBy: { name: 'asc' } });
}

/** One store the user may chat for, or a 403/404. */
async function storeFor(user, storeId) {
  if (!storeId) throw fail(400, 'storeId wajib diisi');
  const stores = await storesFor(user);
  const store = stores.find(s => s.id === storeId);
  if (!store) throw fail(403, 'Tidak punya akses ke toko ini');
  return store;
}

/** One line for a list preview, whatever the message type. */
function previewOf(type, content) {
  if (content?.text) return content.text;
  switch (type) {
    case 'image': return '[Gambar]';
    case 'sticker': return '[Stiker]';
    case 'video': return '[Video]';
    case 'order': return content?.order_sn ? `[Pesanan ${content.order_sn}]` : '[Pesanan]';
    case 'item':
    case 'product': return '[Produk]';
    case 'voucher': return '[Voucher]';
    default: return type ? `[${type}]` : '';
  }
}

/**
 * Shopee's nanosecond timestamp as epoch milliseconds.
 *
 * It arrives as a number already rounded past 2^53 — harmless at millisecond
 * resolution, which is all a list needs.
 */
function nanoToMs(nano) {
  const n = Number(nano);
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 1e6) : null;
}

function mapConversation(c, store) {
  const buyerId = c.to_id != null ? String(c.to_id) : '';
  return {
    id: String(c.conversation_id),
    storeId: store.id,
    storeName: store.name,
    buyerId,
    buyerName: c.to_name || 'Pembeli',
    avatar: c.to_avatar || null,
    unread: Number(c.unread_count) || 0,
    pinned: Boolean(c.pinned),
    lastMessage: previewOf(c.latest_message_type, c.latest_message_content),
    lastMessageId: c.latest_message_id ? String(c.latest_message_id) : null,
    // The buyer's turn to wait: the last word was theirs.
    awaitingReply: c.latest_message_from_id != null && String(c.latest_message_from_id) === buyerId,
    lastAt: nanoToMs(c.last_message_timestamp),
  };
}

function mapMessage(m, store, sentByName) {
  const content = m.content || {};
  return {
    id: String(m.message_id),
    type: m.message_type,
    // Messages the shop sent carry the shop's id; the buyer's carry 0.
    fromShop: String(m.from_shop_id || '') === String(store.shopId),
    text: content.text || null,
    imageUrl: content.url || content.image_url || null,
    orderSn: content.order_sn || m.source_content?.order_sn || null,
    itemId: content.item_id != null ? String(content.item_id) : null,
    preview: previewOf(m.message_type, content),
    // created_timestamp is in seconds
    createdAt: m.created_timestamp ? Number(m.created_timestamp) * 1000 : null,
    status: m.status || null,
    source: m.source || null,
    sentBy: sentByName || null,
  };
}

/**
 * Where each store's list stopped, carried by the client between pages.
 *
 * Opaque to the browser. `null` for a store means it has nothing older left.
 */
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw fail(400, 'cursor tidak valid');
  }
}

function encodeCursor(map) {
  return Object.values(map).some(Boolean)
    ? Buffer.from(JSON.stringify(map)).toString('base64url')
    : null;
}

/**
 * Conversations across every store the user may see, newest first.
 *
 * One page per store, merged. A store that fails is reported and skipped
 * rather than blanking the inbox — except when every store fails for want of
 * permission, which means the app has no chat access at all.
 *
 * @param {Object} user
 * @param {Object} [opts]
 * @param {string} [opts.storeId] - Only this store
 * @param {'all'|'unread'} [opts.type='all']
 * @param {string} [opts.cursor] - From the previous page
 */
async function listConversations(user, { storeId, type = 'all', cursor } = {}) {
  let stores = storeId ? [await storeFor(user, storeId)] : await storesFor(user);
  const previous = decodeCursor(cursor);
  // On a follow-up page only the stores with more to give are asked again
  if (previous) stores = stores.filter(s => previous[s.id]);

  const results = await mapWithConcurrency(stores, CALL_CONCURRENCY, async (store) => {
    try {
      const accessToken = await ensureFreshToken(store);
      const resp = await shopeeService.getConversationList(accessToken, store.shopId, {
        type: type === 'unread' ? 'unread' : 'all',
        nextTimestampNano: previous?.[store.id] || undefined,
        pageSize: 25,
      });
      const page = resp.response?.page_result || {};
      return {
        store,
        conversations: (resp.response?.conversations || []).map(c => mapConversation(c, store)),
        next: page.more ? String(page.next_cursor?.next_message_time_nano || '') || null : null,
      };
    } catch (err) {
      return { store, error: err };
    }
  });

  const failed = results.filter(r => r.error);
  if (failed.length > 0 && failed.length === results.length && failed.every(r => isPermissionError(r.error))) {
    throw translate(failed[0].error);
  }

  const nextMap = {};
  for (const r of results) nextMap[r.store.id] = r.next || null;

  return {
    conversations: results
      .flatMap(r => r.conversations || [])
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)),
    nextCursor: encodeCursor(nextMap),
    errors: failed.map(r => ({
      storeId: r.store.id,
      store: r.store.name,
      message: translate(r.error, 'Gagal memuat chat').message,
    })),
  };
}

/**
 * One page of a conversation, newest first, with our operators' names on the
 * replies they sent.
 */
async function listMessages(user, { storeId, conversationId, offset }) {
  const store = await storeFor(user, storeId);
  let resp;
  try {
    const accessToken = await ensureFreshToken(store);
    resp = await shopeeService.getChatMessages(accessToken, store.shopId, conversationId, { offset, pageSize: 50 });
  } catch (err) {
    throw translate(err, 'Gagal memuat pesan');
  }

  const raw = resp.response?.messages || [];
  const ids = raw.map(m => String(m.message_id));
  const replies = ids.length === 0 ? [] : await prisma.chatReply.findMany({
    where: { storeId: store.id, messageId: { in: ids } },
    select: { messageId: true, sentBy: { select: { name: true } } },
  });
  const authors = new Map(replies.map(r => [r.messageId, r.sentBy?.name]));

  return {
    messages: raw.map(m => mapMessage(m, store, authors.get(String(m.message_id)))),
    nextOffset: raw.length > 0 && resp.response?.page_result?.next_offset
      ? String(resp.response.page_result.next_offset)
      : null,
  };
}

async function markRead(user, { storeId, conversationId, lastMessageId }) {
  const store = await storeFor(user, storeId);
  if (!lastMessageId) throw fail(400, 'lastMessageId wajib diisi');
  try {
    const accessToken = await ensureFreshToken(store);
    await shopeeService.readConversation(accessToken, store.shopId, conversationId, lastMessageId);
  } catch (err) {
    throw translate(err, 'Gagal menandai sudah dibaca');
  }
  unreadCache.delete(store.id);
}

/**
 * Send a reply and record who sent it.
 *
 * @param {Object} user
 * @param {Object} msg
 * @param {string} msg.storeId
 * @param {string} msg.conversationId
 * @param {string} msg.toId
 * @param {string} [msg.text]
 * @param {{ buffer: Buffer, filename: string, contentType: string }} [msg.image]
 */
async function sendReply(user, { storeId, conversationId, toId, text, image }) {
  const store = await storeFor(user, storeId);
  if (!/^\d+$/.test(String(toId || ''))) throw fail(400, 'toId tidak valid');

  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!image) {
    if (!trimmed) throw fail(400, 'Pesan kosong');
    // Counted in characters, as Shopee counts — an emoji is one, not two
    if ([...trimmed].length > MAX_TEXT_LENGTH) throw fail(400, SEND_ERRORS.message_too_long);
  }

  let resp;
  let imageUrl = null;
  try {
    const accessToken = await ensureFreshToken(store);
    if (image) {
      ({ url: imageUrl } = await shopeeService.uploadChatImage(accessToken, store.shopId, image.buffer, {
        filename: image.filename, contentType: image.contentType,
      }));
      resp = await shopeeService.sendChatMessage(accessToken, store.shopId, { toId, type: 'image', imageUrl });
    } else {
      resp = await shopeeService.sendChatMessage(accessToken, store.shopId, { toId, type: 'text', text: trimmed });
    }
  } catch (err) {
    throw translate(err, 'Gagal mengirim pesan');
  }

  const sent = resp.response || {};
  await prisma.chatReply.create({
    data: {
      storeId: store.id,
      conversationId: String(conversationId),
      messageId: sent.message_id ? String(sent.message_id) : null,
      toId: String(toId),
      messageType: image ? 'image' : 'text',
      text: image ? null : trimmed,
      imageUrl,
      sentById: user.id,
    },
  }).catch((err) => {
    // The buyer already has the message; failing the request now would only
    // invite the operator to send it a second time.
    console.error(`[chat] Reply sent but not recorded for store ${store.id}: ${err.message}`);
  });

  return {
    message: {
      id: sent.message_id ? String(sent.message_id) : `local-${Date.now()}`,
      type: image ? 'image' : 'text',
      fromShop: true,
      text: image ? null : trimmed,
      imageUrl,
      orderSn: null,
      itemId: null,
      preview: image ? '[Gambar]' : trimmed,
      createdAt: sent.created_timestamp ? Number(sent.created_timestamp) * 1000 : Date.now(),
      status: 'normal',
      source: 'openapi',
      sentBy: null,
    },
  };
}

/**
 * Unread conversations per store, cached briefly.
 *
 * Every open tab polls this for the sidebar badge; without the cache ten
 * operators would ask Shopee the same question for every store every minute.
 */
const UNREAD_TTL_MS = 30_000;
const unreadCache = new Map();

async function unreadCounts(user) {
  const stores = await storesFor(user);
  const now = Date.now();

  const perStore = await mapWithConcurrency(stores, CALL_CONCURRENCY, async (store) => {
    const hit = unreadCache.get(store.id);
    if (hit && now - hit.at < UNREAD_TTL_MS) return hit.value;

    let value;
    try {
      const accessToken = await ensureFreshToken(store);
      const resp = await shopeeService.getUnreadConversationCount(accessToken, store.shopId);
      value = { storeId: store.id, store: store.name, unread: Number(resp.response?.total_unread_count) || 0 };
    } catch (err) {
      value = { storeId: store.id, store: store.name, unread: 0, error: translate(err, 'Gagal').message, permission: isPermissionError(err) };
    }
    unreadCache.set(store.id, { at: now, value });
    return value;
  });

  return {
    total: perStore.reduce((n, s) => n + s.unread, 0),
    stores: perStore,
    // Every store refused for want of permission: the app has no chat access
    enabled: !(perStore.length > 0 && perStore.every(s => s.permission)),
  };
}

/**
 * The buyer's orders in this store, for the panel beside the conversation.
 *
 * Matched on Shopee's buyer id, plus any order numbers the conversation itself
 * mentions — which also catches orders synced before the id was recorded.
 */
async function buyerOrders(user, { storeId, buyerId, orderSns = [] }) {
  const store = await storeFor(user, storeId);
  const or = [];
  if (buyerId) or.push({ buyerUserId: String(buyerId) });
  const sns = orderSns.filter(Boolean).slice(0, 50);
  if (sns.length > 0) or.push({ orderId: { in: sns } });
  if (or.length === 0) return { orders: [] };

  const rows = await prisma.order.findMany({
    where: { storeId: store.id, OR: or },
    orderBy: { orderDate: 'desc' },
    take: 20,
  });

  let items;
  return {
    orders: rows.map(o => {
      try { items = JSON.parse(o.items || '[]'); } catch { items = []; }
      return {
        id: o.id,
        orderId: o.orderId,
        packageNumber: o.packageNumber || '',
        status: o.status,
        logisticsStatus: o.logisticsStatus,
        courier: o.shippingCourier,
        trackingNumber: o.trackingNumber,
        orderDate: o.orderDate,
        shipByDate: o.shipByDate,
        printedAt: o.printedAt,
        buyerNote: o.buyerNote,
        items: (Array.isArray(items) ? items : []).map(i => ({
          name: i.name || i.item_name || 'Produk',
          variant: i.variant || i.model_name || null,
          qty: i.quantity || i.qty || 1,
        })),
      };
    }),
  };
}

module.exports = {
  MAX_TEXT_LENGTH,
  storesFor,
  listConversations,
  listMessages,
  markRead,
  sendReply,
  unreadCounts,
  buyerOrders,
  // exported for tests
  isPermissionError,
  mapConversation,
  mapMessage,
  previewOf,
  decodeCursor,
  encodeCursor,
};
