'use strict';

const { PrismaClient } = require('@prisma/client');
const config = require('../config');

/**
 * Singleton Prisma client.
 *
 * In development, attach to `globalThis` so hot-reloading via nodemon
 * doesn't create dozens of idle connections.
 */

let prisma;

if (config.env === 'production') {
  prisma = new PrismaClient({
    log: ['error', 'warn'],
  });
} else {
  // Reuse existing instance across HMR / nodemon restarts
  if (!globalThis.__prisma) {
    globalThis.__prisma = new PrismaClient({
      log: ['query', 'error', 'warn'],
    });
  }
  prisma = globalThis.__prisma;
}

module.exports = prisma;
