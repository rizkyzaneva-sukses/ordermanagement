#!/usr/bin/env node
'use strict';

/**
 * probe-chat-list.js — why does get_conversation_list come back empty?
 *
 * The inbox showed no conversations while Shopee answered every call with no
 * error. That leaves the parameters: the docs say an omitted
 * next_timestamp_nano means "infinitely large", but the empty result looks
 * like "older than 0". This asks Shopee with each plausible combination and
 * prints how many conversations each one returns.
 *
 * READ-ONLY, and nothing personal is printed: counts, paging fields and the
 * field names of the first conversation — no buyer names, no message text.
 *
 * Usage, from inside the running container:
 *
 *   node scripts/probe-chat-list.js             # first healthy Shopee store
 *   node scripts/probe-chat-list.js <storeId>   # a specific store
 */

const prisma = require('../src/prisma/client.js');
const shopeeService = require('../src/services/shopee.js');
const { ensureFreshToken } = require('../src/services/tokens.js');

const PATH = '/api/v2/sellerchat/get_conversation_list';
const nowNano = String(BigInt(Date.now() + 60_000) * 1_000_000n);

const VARIANTS = [
  { label: 'older, no timestamp (old behaviour)', params: { direction: 'older', type: 'all', page_size: 10 } },
  { label: 'older, timestamp = now (new behaviour)', params: { direction: 'older', type: 'all', page_size: 10, next_timestamp_nano: nowNano } },
  { label: 'latest, timestamp = 0', params: { direction: 'latest', type: 'all', page_size: 10, next_timestamp_nano: '0' } },
  { label: 'latest, no timestamp', params: { direction: 'latest', type: 'all', page_size: 10 } },
  { label: 'older, timestamp = now, unread only', params: { direction: 'older', type: 'unread', page_size: 10, next_timestamp_nano: nowNano } },
];

async function probe(variant, accessToken, shopId) {
  const url = shopeeService._buildUrl(PATH, variant.params, accessToken, String(shopId));
  try {
    const response = await fetch(url, { method: 'GET' });
    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      console.log(`  ${variant.label}\n    HTTP ${response.status}, unparseable: ${raw.slice(0, 120)}`);
      return;
    }
    const r = body.response || {};
    const list = Array.isArray(r.conversations) ? r.conversations : null;
    console.log(`  ${variant.label}`);
    console.log(`    error         : ${body.error || '(none)'} ${body.message ? `— ${body.message}` : ''}`);
    console.log(`    response keys : ${Object.keys(r).join(', ') || '(empty)'}`);
    console.log(`    conversations : ${list ? list.length : 'not an array'}`);
    console.log(`    page_result   : ${JSON.stringify(r.page_result || null)}`);
    if (list && list[0]) console.log(`    fields        : ${Object.keys(list[0]).join(', ')}`);
  } catch (err) {
    console.log(`  ${variant.label}\n    Network failure: ${err.message}`);
  }
}

async function main() {
  const storeId = process.argv[2];
  const store = storeId
    ? await prisma.store.findUnique({ where: { id: storeId } })
    : await prisma.store.findFirst({
      where: { platform: 'SHOPEE', isActive: true, needsReconnect: false },
      orderBy: { lastSyncAt: 'desc' },
    });

  if (!store) {
    console.error('No usable Shopee store found. Pass a storeId.');
    process.exitCode = 1;
    return;
  }

  console.log(`\nget_conversation_list for "${store.name}" (shop_id ${store.shopId}) — read-only\n`);
  const accessToken = await ensureFreshToken(store);

  for (const v of VARIANTS) {
    await probe(v, accessToken, store.shopId);
    console.log('');
  }

  const unread = await shopeeService.getUnreadConversationCount(accessToken, store.shopId).catch((e) => ({ error: e.message }));
  console.log(`get_unread_conversation_count: ${JSON.stringify(unread.response ?? unread)}`);
}

main()
  .catch((err) => {
    console.error('\nProbe aborted:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
