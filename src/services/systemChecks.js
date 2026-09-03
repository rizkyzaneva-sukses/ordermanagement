'use strict';

/**
 * systemChecks.js — does this deployment still have everything it needs?
 *
 * Aimed at one class of failure: the app builds, starts, and looks healthy, but
 * something in its environment is missing or has drifted — an unset credential,
 * an unwritable folder, a Redis nobody is consuming, an IP that Shopee no
 * longer recognises. None of it is visible to a compiler, and none of it
 * announces itself: the symptom is an empty order list, or an error whose text
 * says nothing about the cause.
 *
 * Deliberately server-side. A browser cannot see an environment variable, a
 * directory permission, or whether a worker is consuming a queue, so a
 * diagnostic running in the page could only ever reach the shallowest layer.
 *
 * What this is NOT: a test of whether the data is correct. Every check here can
 * pass while the order list disagrees with Seller Centre — that is what the
 * sync comparison panel is for. This answers "is the plumbing connected", and
 * the UI has to say so, because "semua sehat" is otherwise read as "the app is
 * right".
 *
 * Nothing here writes to a business table. The one check that writes at all
 * creates a single temporary file in the storage directory and removes it
 * again, and is labelled as writing in the UI rather than only in this comment.
 */

const fs   = require('fs/promises');
const path = require('path');

const prisma        = require('../prisma/client.js');
const config        = require('../config/index.js');
const shopeeService = require('./shopee.js');
const { encrypt, decrypt } = require('../utils/crypto.js');
const { syncQueue, isRedisReady, hasQueueWorkers } = require('./queue.js');
const scheduler = require('./scheduler.js');

/** Prisma saying the database lacks what the code expects. */
const MISSING_DB_OBJECT = /P2021|P2022|does not exist|Unknown arg/i;

/**
 * Turn a thrown error into a verdict, keeping the raw message whatever happens.
 *
 * Summarising it to "Terjadi kesalahan" would discard the only part nobody can
 * guess from outside, and that sentence is usually the entire diagnosis.
 */
function fromError(err) {
  const message = err && err.message ? err.message : String(err);
  return {
    status: 'fail',
    detail: MISSING_DB_OBJECT.test(message)
      ? 'Objek database yang dipakai kode tidak ada: ' + message
      : message,
  };
}

/** Env vars that must carry a value for the app to function at all. */
function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n] || String(process.env[n]).trim() === '');
  return missing.length === 0
    ? { status: 'ok', detail: names.length + ' variabel terisi' }
    : { status: 'fail', detail: 'Belum diisi: ' + missing.join(', ') };
}

const CHECKS = [
  // ── Konfigurasi ────────────────────────────────────────────────────────────
  {
    id: 'env-core',
    group: 'Konfigurasi',
    name: 'Kunci rahasia aplikasi terisi',
    kind: 'baca',
    run: async () => requireEnv(['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY']),
  },
  {
    id: 'encryption-roundtrip',
    group: 'Konfigurasi',
    name: 'Enkripsi token bisa dibaca kembali',
    kind: 'baca',
    // Worth its own check: shop tokens are stored encrypted, so a changed
    // ENCRYPTION_KEY breaks nothing at boot — every shop simply starts failing
    // to authenticate against Shopee, with errors that blame Shopee.
    run: async () => {
      const sample = 'orderpro-system-check';
      return decrypt(encrypt(sample)) === sample
        ? { status: 'ok', detail: 'Enkripsi dan dekripsi cocok' }
        : { status: 'fail', detail: 'Hasil dekripsi tidak sama dengan aslinya — ENCRYPTION_KEY kemungkinan sudah berubah, dan token toko yang tersimpan tidak lagi bisa dibaca' };
    },
  },
  {
    id: 'env-shopee',
    group: 'Konfigurasi',
    name: 'Kredensial partner Shopee terisi',
    kind: 'baca',
    run: async () => requireEnv(['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY']),
  },
  {
    id: 'business-offset',
    group: 'Konfigurasi',
    name: 'Zona waktu bisnis berbentuk benar',
    kind: 'baca',
    run: async () => {
      const value = config.business.utcOffset;
      return /^[+-]\d{2}:\d{2}$/.test(value)
        ? { status: 'ok', detail: 'BUSINESS_UTC_OFFSET = ' + value }
        : { status: 'fail', detail: 'BUSINESS_UTC_OFFSET = "' + value + '" tidak berbentuk +07:00 — batas "hari ini" akan meleset' };
    },
  },

  // ── Database ───────────────────────────────────────────────────────────────
  {
    id: 'db-connection',
    group: 'Database',
    name: 'Database bisa dihubungi',
    kind: 'baca',
    run: async () => {
      await prisma.$queryRawUnsafe('SELECT 1');
      return { status: 'ok', detail: 'Terhubung' };
    },
  },
  {
    id: 'db-migrations',
    group: 'Database',
    name: 'Semua migrasi sudah dijalankan',
    kind: 'baca',
    run: async () => {
      const dir = path.resolve(__dirname, '../../prisma/migrations');
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const onDisk = entries.filter((e) => e.isDirectory()).map((e) => e.name);

      const rows = await prisma.$queryRawUnsafe(
        'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL');
      const applied = new Set(rows.map((r) => r.migration_name));

      const pending = onDisk.filter((name) => !applied.has(name));
      return pending.length === 0
        ? { status: 'ok', detail: onDisk.length + ' migrasi, semuanya sudah diterapkan' }
        : { status: 'fail', detail: 'Belum diterapkan: ' + pending.join(', ') };
    },
  },
  {
    id: 'db-columns',
    group: 'Database',
    name: 'Kolom yang dipakai kode ada di database',
    kind: 'baca',
    // The bug a compiler cannot see: the code names a column, the database does
    // not have it, and nothing complains until a real request arrives. Reading
    // the newest columns proves schema and code still agree.
    run: async () => {
      await prisma.order.findFirst({
        select: { shipByDate: true, logisticsStatus: true, logisticsChannelId: true, packageNumber: true },
      });
      await prisma.store.findFirst({
        select: { lastSyncCounts: true, lastSyncStatus: true, needsReconnect: true },
      });
      return { status: 'ok', detail: 'Kolom terbaru pada Order dan Store terbaca' };
    },
  },

  // ── Antrean & worker ───────────────────────────────────────────────────────
  {
    id: 'redis',
    group: 'Antrean & Worker',
    name: 'Redis bisa dihubungi',
    kind: 'baca',
    run: async () => (isRedisReady()
      ? { status: 'ok', detail: 'Terhubung' }
      : { status: 'fail', detail: 'Redis tidak terhubung — sync manual masih jalan, tapi tidak ada yang terjadwal' }),
  },
  {
    id: 'worker',
    group: 'Antrean & Worker',
    name: 'Worker mengonsumsi antrean',
    kind: 'baca',
    // Redis being up is not the same as something listening. A queued job with
    // no consumer looks exactly like success from the API side.
    run: async () => (await hasQueueWorkers(syncQueue)
      ? { status: 'ok', detail: 'Ada worker yang siap mengambil pekerjaan' }
      : { status: 'fail', detail: 'Tidak ada worker — pekerjaan sync akan mengendap di antrean tanpa dikerjakan' }),
  },
  {
    id: 'scheduler',
    group: 'Antrean & Worker',
    name: 'Sync otomatis terjadwal',
    kind: 'baca',
    run: async () => (scheduler.isAutoSyncRunning()
      ? { status: 'ok', detail: 'Jadwal berulang terdaftar' }
      : { status: 'warn', detail: 'Tidak ada jadwal berulang terdaftar — pesanan baru hanya masuk saat tombol Sync ditekan' }),
  },

  // ── Shopee ─────────────────────────────────────────────────────────────────
  {
    id: 'shopee-public-api',
    group: 'Shopee',
    name: 'Shopee menjawab panggilan kita',
    kind: 'eksternal',
    // The most valuable check here. One public call exercises the partner id,
    // the partner key, the signature formula and the IP whitelist at once — and
    // those are exactly the failures that stop the whole app while reporting
    // something that mentions none of them.
    run: async () => {
      const shops = await shopeeService.getAllShopsByPartner(1);
      return {
        status: 'ok',
        detail: 'Shopee menjawab — ' + shops.length + ' toko terotorisasi terbaca. Partner ID, partner key, tanda tangan, dan IP whitelist semuanya berfungsi.',
      };
    },
  },
  {
    id: 'shopee-key-expiry',
    group: 'Shopee',
    name: 'Sisa umur partner key',
    kind: 'baca',
    // Not available from any API — it lives only on the console page, so it has
    // to be told to us. Worth the trouble: when the key lapses every shop stops
    // syncing at once, and nothing in the resulting errors says why.
    run: async () => {
      const raw = process.env.SHOPEE_PARTNER_KEY_EXPIRES;
      if (!raw) {
        return {
          status: 'warn',
          detail: 'SHOPEE_PARTNER_KEY_EXPIRES belum diisi. Tanggalnya ada di Shopee Open Platform Console, App List, detail app ("Live API Partner Key Expire Time"). Isi dengan format YYYY-MM-DD supaya sisa harinya bisa diawasi.',
        };
      }
      const expires = new Date(raw + 'T23:59:59' + config.business.utcOffset);
      if (Number.isNaN(expires.getTime())) {
        return { status: 'fail', detail: 'SHOPEE_PARTNER_KEY_EXPIRES = "' + raw + '" bukan tanggal yang bisa dibaca (harusnya YYYY-MM-DD)' };
      }
      const days = Math.floor((expires.getTime() - Date.now()) / 86400000);
      if (days < 0)  return { status: 'fail', detail: 'Partner key sudah kedaluwarsa ' + Math.abs(days) + ' hari lalu — seluruh sync akan berhenti' };
      if (days < 60) return { status: 'warn', detail: 'Tersisa ' + days + ' hari (' + raw + ') — perpanjang sebelum habis, karena saat habis semua toko berhenti sync bersamaan' };
      return { status: 'ok', detail: 'Tersisa ' + days + ' hari (' + raw + ')' };
    },
  },
  {
    id: 'store-tokens',
    group: 'Shopee',
    name: 'Token toko masih sehat',
    kind: 'baca',
    run: async () => {
      const stores = await prisma.store.findMany({
        where: { isActive: true, platform: 'SHOPEE' },
        select: { name: true, needsReconnect: true },
      });
      if (stores.length === 0) return { status: 'warn', detail: 'Belum ada toko Shopee yang tersambung' };

      const broken = stores.filter((s) => s.needsReconnect);
      return broken.length === 0
        ? { status: 'ok', detail: stores.length + ' toko, semuanya tidak perlu otorisasi ulang' }
        : { status: 'fail', detail: 'Perlu otorisasi ulang: ' + broken.map((s) => s.name).join(', ') };
    },
  },

  // ── Penyimpanan ────────────────────────────────────────────────────────────
  {
    id: 'storage-writable',
    group: 'Penyimpanan',
    name: 'Folder penyimpanan bisa ditulis',
    kind: 'tulis',
    // The one check that writes, and the only way to prove it: a directory can
    // exist, be readable, and still refuse writes — which surfaces later as an
    // AWB download failing for reasons that look like Shopee's fault.
    run: async () => {
      const dir = config.storage.dir;
      await fs.mkdir(dir, { recursive: true });

      const probe = path.join(dir, '.system-check-' + Date.now());
      try {
        await fs.writeFile(probe, 'orderpro system check');
        await fs.readFile(probe);
        return { status: 'ok', detail: dir + ' — bisa ditulis dan dibaca' };
      } finally {
        // Removed whether or not the read succeeded, so repeated runs never
        // leave a trail of probe files behind.
        await fs.rm(probe, { force: true });
      }
    },
  },
];

/**
 * Run one check, never letting it throw.
 *
 * @param {Object} check
 * @returns {Promise<Object>}
 */
async function runCheck(check) {
  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await check.run();
  } catch (err) {
    outcome = fromError(err);
  }
  return {
    id:         check.id,
    group:      check.group,
    name:       check.name,
    kind:       check.kind,
    status:     outcome.status,
    detail:     outcome.detail,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Run every check, or just one.
 *
 * Sequential on purpose: several touch the same database and the same Shopee
 * rate limit, and a diagnostic that is itself a burst of load is a poor one.
 *
 * @param {Object} [options]
 * @param {string} [options.only] - A single check id
 * @returns {Promise<Object>}
 */
async function runAll({ only } = {}) {
  const selected = only ? CHECKS.filter((c) => c.id === only) : CHECKS;
  if (selected.length === 0) {
    const err = new Error('Pemeriksaan "' + only + '" tidak dikenal');
    err.statusCode = 404;
    throw err;
  }

  const startedAt = Date.now();
  const results = [];
  for (const check of selected) results.push(await runCheck(check));

  return {
    ranAt:   new Date().toISOString(),
    totalMs: Date.now() - startedAt,
    summary: {
      total: results.length,
      ok:    results.filter((r) => r.status === 'ok').length,
      warn:  results.filter((r) => r.status === 'warn').length,
      fail:  results.filter((r) => r.status === 'fail').length,
    },
    results,
  };
}

module.exports = { CHECKS, runCheck, runAll };
