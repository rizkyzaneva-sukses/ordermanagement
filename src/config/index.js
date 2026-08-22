'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3001',

  database: {
    url: process.env.DATABASE_URL || 'postgresql://orderpro:orderpro@localhost:5432/orderpro',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiresIn: '15m',
    refreshExpiresIn: '7d',
  },

  encryption: {
    key: process.env.ENCRYPTION_KEY,
  },

  shopee: {
    partnerId: process.env.SHOPEE_PARTNER_ID || '',
    partnerKey: process.env.SHOPEE_PARTNER_KEY || '',
    baseUrl: 'https://partner.shopeemobile.com/api/v2',
  },

  tiktok: {
    appKey: process.env.TIKTOK_APP_KEY || '',
    appSecret: process.env.TIKTOK_APP_SECRET || '',
    baseUrl: 'https://open-api.tiktokglobalshop.com',
  },

  upload: {
    maxFileSize: 10 * 1024 * 1024, // 10 MB
    allowedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg'],
  },

  // Generated files (batch PDFs, downloaded air waybills).
  //
  // Must point at the same place for the API and the worker: the worker writes
  // a batch PDF and the API serves it back, so on a split deployment (separate
  // containers) this has to be a shared volume or the download 404s.
  storage: {
    dir: process.env.STORAGE_DIR
      ? path.resolve(process.env.STORAGE_DIR)
      : path.resolve(__dirname, '../../storage'),
  },

  // The seller's business day. Date filters arrive as a bare YYYY-MM-DD from a
  // date picker, and a day only means something once anchored to a zone —
  // relying on the server's own would silently shift every "hari ini" by seven
  // hours the moment the app runs in a UTC container.
  business: {
    utcOffset: process.env.BUSINESS_UTC_OFFSET || '+07:00',
  },

  queue: {
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 86400 },   // 24 hours
      removeOnFail: { age: 604800 },       // 7 days
    },
  },
};

// Validate required secrets in production
if (config.env === 'production') {
  const required = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY'];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required env variable: ${key}`);
    }
  }

  if (config.encryption.key.length !== 64) {
    // 32 bytes = 64 hex chars
    throw new Error('ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters)');
  }
}

module.exports = config;
