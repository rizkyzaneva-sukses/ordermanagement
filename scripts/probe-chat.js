#!/usr/bin/env node
'use strict';

/**
 * probe-chat.js — does this app actually have access to Shopee's chat API?
 *
 * Everything written about this so far has been inference from second-hand
 * sources: that the chat endpoints are whitelist-only and need an OAuth scope
 * the order permissions do not include. That may be right, it may be out of
 * date, and it may differ for this partner account. Guessing wrong in either
 * direction is expensive — building a feature that cannot run, or telling the
 * merchant to chase a whitelist they already have.
 *
 * So this asks Shopee directly, with the real token of a real connected shop,
 * and prints whatever comes back verbatim.
 *
 * READ-ONLY BY CONSTRUCTION. `send_message` is deliberately absent: a probe
 * that can message a buyer is not a probe. Only listing endpoints are called,
 * and nothing is written to the database.
 *
 * Usage, from inside the running container:
 *
 *   node scripts/probe-chat.js                # first healthy Shopee store
 *   node scripts/probe-chat.js <storeId>      # a specific store
 */

const prisma = require('../src/prisma/client.js');
const shopeeService = require('../src/services/shopee.js');
const { ensureFreshToken } = require('../src/services/tokens.js');

/**
 * Endpoint names are themselves part of what is being tested.
 *
 * The path for seller chat is not documented anywhere this project can reach,
 * so the plausible spellings are all tried. A wrong path and a forbidden path
 * fail differently, and telling those two apart is most of the point: one means
 * "rename it", the other means "go ask Shopee for access".
 */
const READ_ONLY_ENDPOINTS = [
  { path: '/api/v2/sellerchat/get_conversation_list', params: { page_size: 1, direction: 'latest', type: 'all' } },
  { path: '/api/v2/sellerchat/get_unread_conversation_count', params: {} },
  { path: '/api/v2/sellerchat/get_conversation_list', params: { page_size: 1 }, label: 'minimal params' },
];

function heading(text) {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`);
}

/**
 * Call one endpoint and report the raw answer.
 *
 * Deliberately bypasses ShopeeService._request: that one retries and throws on
 * any `error` field, and here the error field *is* the result being collected.
 */
async function probe(endpoint, accessToken, shopId) {
  const label = endpoint.label ? `${endpoint.path} (${endpoint.label})` : endpoint.path;
  const url = shopeeService._buildUrl(endpoint.path, endpoint.params, accessToken, String(shopId));

  try {
    const response = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    const raw = await response.text();

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      console.log(`${label}\n  HTTP ${response.status}, unparseable body: ${raw.slice(0, 200)}`);
      return null;
    }

    console.log(`${label}`);
    console.log(`  HTTP    : ${response.status}`);
    console.log(`  error   : ${body.error || '(none)'}`);
    console.log(`  message : ${body.message || '(none)'}`);
    console.log(`  keys    : ${Object.keys(body.response || {}).join(', ') || '(no response object)'}`);
    return body;
  } catch (err) {
    console.log(`${label}\n  Network failure: ${err.message}`);
    return null;
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
    console.error('No usable Shopee store found. Connect one first, or pass a storeId.');
    process.exitCode = 1;
    return;
  }

  heading(`Probing chat access for "${store.name}" (shop_id ${store.shopId})`);
  console.log('Read-only. No message is sent, nothing is written.\n');

  const accessToken = await ensureFreshToken(store);

  const results = [];
  for (const endpoint of READ_ONLY_ENDPOINTS) {
    results.push(await probe(endpoint, accessToken, store.shopId));
    console.log('');
  }

  heading('How to read this');

  const anySuccess = results.some((r) => r && !r.error);
  const errors = results.filter(Boolean).map((r) => String(r.error || '')).filter(Boolean);

  if (anySuccess) {
    console.log('At least one call succeeded — this shop ALREADY has chat access.');
    console.log('No whitelist request is needed. The endpoint that worked is the one to build on.');
  } else if (errors.some((e) => /auth|permission|scope|access/i.test(e))) {
    console.log('Shopee answered with a permission error.');
    console.log('That is the whitelist / OAuth-scope case: the endpoints exist and this app');
    console.log('is not allowed to call them yet. Ask Shopee Open Platform for chat API');
    console.log('access, then every shop has to be re-authorized to pick up the new scope.');
  } else if (errors.some((e) => /not_found|invalid.*path|no.*api/i.test(e))) {
    console.log('Shopee did not recognise the path. The endpoint names above are guesses,');
    console.log('so this is inconclusive about access — the spelling needs correcting first.');
  } else {
    console.log('Inconclusive. Copy the raw output above; the error strings are the evidence.');
  }

  heading('Done — nothing was sent, nothing was modified');
}

main()
  .catch((err) => {
    console.error('\nProbe aborted:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
