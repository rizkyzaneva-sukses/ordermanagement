'use strict';

/**
 * activity.js — who did what, for the admin's Log Aktivitas.
 *
 * Recorded from one middleware rather than a call in every handler: there are
 * some forty write routes, and a log that depends on each handler remembering
 * to call it goes quiet on exactly the route someone forgot. The price is that
 * a line here is described by its route, not by the handler's own words — so
 * the route table below is where the Indonesian labels live.
 *
 * Only routes in that table are recorded. Reads, selection toggles and previews
 * would bury the actions an admin is actually looking for.
 */

const prisma = require('../prisma/client');

/** Days a line is kept. The log answers "who did this last week", not an audit. */
const RETENTION_DAYS = parseInt(process.env.ACTIVITY_RETENTION_DAYS, 10) || 180;

/**
 * "METHOD /full/route/pattern" → label, as Express reports the matched route.
 */
const ACTIONS = {
  // Pesanan
  'POST /api/orders/sync': 'Sinkron pesanan',
  'POST /api/orders/sync-mass': 'Sinkron massal',
  'POST /api/orders/:id/sync': 'Sinkron satu pesanan',
  'POST /api/orders/ship-mass': 'Atur pengiriman massal',
  'POST /api/orders/retry-ship-mass': 'Ulangi atur pengiriman massal',
  'POST /api/orders/:id/ship': 'Atur pengiriman',
  'POST /api/orders/:id/retry-ship': 'Ulangi atur pengiriman',
  'POST /api/orders/:id/cancel': 'Batalkan pesanan',
  'POST /api/orders/:id/handle-cancellation': 'Tanggapi permintaan batal',
  'POST /api/orders/:id/split': 'Pecah pesanan',
  'POST /api/orders/:id/unsplit': 'Batalkan pecah pesanan',
  'POST /api/orders/refresh-tracking': 'Perbarui nomor resi',
  'POST /api/orders/refresh-tracking-all': 'Perbarui semua nomor resi',
  'POST /api/orders/:id/refresh-tracking': 'Perbarui nomor resi',
  'POST /api/orders/print': 'Cetak resi',
  'POST /api/orders/mark-printed': 'Tandai sudah dicetak',

  // Cetak
  'POST /api/print/batch': 'Cetak resi (batch)',
  'POST /api/print/awb': 'Unduh resi resmi Shopee',
  'POST /api/print/reprint': 'Cetak ulang resi',

  // Produk & stok
  'POST /api/products/sync': 'Tarik katalog produk',
  'POST /api/products/sync-stock': 'Perbarui stok listing',
  'POST /api/products/masters/from-items': 'Jadikan Master',
  'PATCH /api/products/masters/:id': 'Ubah master produk',
  'DELETE /api/products/masters/:id': 'Hapus master produk',
  'POST /api/products/masters/delete': 'Hapus master produk',
  'POST /api/products/masters/stock': 'Edit stok massal',
  'POST /api/products/masters/automap': 'Petakan otomatis',
  'POST /api/products/listings/map': 'Ikat listing ke master',
  'POST /api/products/listings/unmap': 'Lepas listing dari master',
  'POST /api/products/drafts/': 'Salin produk ke draf',
  'PATCH /api/products/drafts/:id': 'Ubah draf produk',
  'POST /api/products/drafts/:id/publish': 'Publikasikan draf',
  'DELETE /api/products/drafts/:id': 'Hapus draf',

  // Chat
  'POST /api/chat/conversations/:id/messages': 'Balas chat',
  'POST /api/chat/conversations/:id/images': 'Kirim gambar di chat',

  // Admin
  'POST /api/stores/quick-connect': 'Sambungkan toko',
  'POST /api/stores/': 'Tambah toko',
  'PATCH /api/stores/:id': 'Ubah toko',
  'DELETE /api/stores/:id': 'Hapus toko',
  'POST /api/stores/:id/reconnect': 'Sambungkan ulang toko',
  'POST /api/users/': 'Tambah user',
  'PATCH /api/users/:id': 'Ubah user',
  'DELETE /api/users/:id': 'Nonaktifkan user',
  'PATCH /api/users/:id/stores': 'Ubah akses toko user',
};

const SECRET_KEY = /pass|token|secret|signature|authorization/i;
const MAX_LIST = 20;
const MAX_TEXT = 200;

/**
 * Shrink a request body to what is worth keeping.
 *
 * Secrets are dropped, long lists are cut to their first few ids plus a count
 * (a mass action on 300 orders would otherwise store 300 ids per line), and
 * long text is truncated.
 */
function summariseBody(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= 3) return '[…]';

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_LIST).map(v => summariseBody(v, depth + 1));
    return value.length > MAX_LIST ? { count: value.length, first: head } : head;
  }

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = summariseBody(v, depth + 1);
  }
  return out;
}

/**
 * The top-level numbers in a response's `data` — "mapped: 5", "failed: 2".
 * They say how the action went without storing the whole response.
 */
function summariseResult(body) {
  const data = body?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const out = {};
  for (const [key, v] of Object.entries(data)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    else if (Array.isArray(v)) out[key] = v.length;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The caller's address. The app sits behind EasyPanel's proxy without `trust proxy`. */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.ip || null;
}

/** Write one line. Never throws: a failed log must not fail the action it records. */
async function write(entry) {
  try {
    await prisma.activityLog.create({ data: entry });
  } catch (err) {
    console.error('[activity] Could not record activity:', err.message);
  }
}

/**
 * Express middleware, mounted once ahead of the API routers.
 *
 * It waits for the response to finish because only then are the user (set by
 * each router's `authenticate`) and the matched route known.
 */
function recordActivity() {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

    let responseBody;
    const json = res.json.bind(res);
    res.json = (body) => {
      responseBody = body;
      return json(body);
    };

    res.on('finish', () => {
      if (!req.user || !req.route) return;
      const action = `${req.method} ${req.baseUrl}${req.route.path}`;
      const label = ACTIONS[action];
      if (!label) return;

      const ok = res.statusCode < 400;
      const detail = {};
      if (req.body && Object.keys(req.body).length > 0) detail.body = summariseBody(req.body);
      const result = summariseResult(responseBody);
      if (result) detail.result = result;
      if (!ok && responseBody?.error) detail.error = summariseBody(String(responseBody.error));

      write({
        userId: req.user.id,
        userEmail: req.user.email ?? null,
        action,
        label,
        targetId: req.params?.id ?? null,
        ok,
        statusCode: res.statusCode,
        detail: Object.keys(detail).length > 0 ? detail : undefined,
        ip: clientIp(req),
      });
    });

    next();
  };
}

/**
 * Record a login attempt. Called by the login handler, which runs before any
 * user is on the request. A failure is kept with the email that was typed,
 * since that is the whole of what an admin can learn from it.
 */
function recordLogin(req, { user, email, ok, reason }) {
  return write({
    userId: user?.id ?? null,
    userEmail: user?.email ?? (email ? String(email).slice(0, MAX_TEXT) : null),
    action: 'POST /api/auth/login',
    label: ok ? 'Login' : 'Login gagal',
    ok,
    statusCode: ok ? 200 : 401,
    detail: reason ? { reason } : undefined,
    ip: clientIp(req),
  });
}

/** Delete lines past the retention window. */
async function pruneOld(days = RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { count } = await prisma.activityLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count > 0) console.log(`[activity] Pruned ${count} log line(s) older than ${days} days`);
  return count;
}

module.exports = {
  ACTIONS,
  RETENTION_DAYS,
  recordActivity,
  recordLogin,
  pruneOld,
  summariseBody,
  summariseResult,
};
