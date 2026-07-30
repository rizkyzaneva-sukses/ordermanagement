'use strict';

/**
 * webhooks.js — Shopee Open Platform push receiver.
 *
 * Shopee pushes an event the moment something happens (an order is placed, its
 * status moves, a tracking number is issued) to the Push URL registered in the
 * Partner Console. That turns order updates from "within 15 minutes" into
 * "within seconds".
 *
 * This deliberately does **not** replace the polling sync, it complements it.
 * A push is delivered once; if this process is mid-deploy, or Redis is down, or
 * the network drops it, the event is gone for good. The scheduled sync stays on
 * as the backstop that reconciles whatever was missed, so a lost push degrades
 * latency rather than losing data.
 *
 * What arrives is treated as a *hint*, not as data: the handler only enqueues a
 * sync for the affected shop and lets the existing pipeline fetch the
 * authoritative state from the API. Trusting the payload's contents would mean a
 * second, subtly different write path for orders — and one that a forged request
 * could drive.
 *
 * ── Mounting ──────────────────────────────────────────────────────────────────
 * The signature covers the raw request body, so this router must be mounted
 * BEFORE any JSON body parser (see server.js). It parses the raw buffer itself.
 */

const express = require('express');
const crypto = require('crypto');
const prisma = require('../prisma/client.js');
const { syncQueue, isRedisReady } = require('../services/queue.js');

const router = express.Router();

/**
 * Push event codes.
 *
 * Only the ones acted on are named; anything else is logged and acknowledged.
 * The numbering is Shopee's and is worth re-checking against the Partner Console
 * before relying on a new one — see the verification note at the bottom.
 */
const EVENT = {
  SHOP_AUTHORIZED:   1,
  SHOP_DEAUTHORIZED: 2,
  ORDER_STATUS:      3,
  TRACKING_NUMBER:   4,
};

/**
 * Collapse a burst of pushes into a single sync.
 *
 * A shop dispatching 50 packages emits 50 events within a second or two, and
 * each one wants the same thing: re-read that shop. The delay gives the burst
 * time to arrive while BullMQ rejects same-id duplicates, so all of them land as
 * one sync a few seconds later instead of 50 competing runs.
 */
const PUSH_DEBOUNCE_MS = 8_000;

/**
 * The URL Shopee was told to push to.
 *
 * It is part of the signed string, so it must match the Partner Console entry
 * character for character — including scheme and any trailing path. Derived from
 * BACKEND_URL, with an override for setups where the public URL differs from
 * what the app knows about itself (a proxy rewriting the path, for instance).
 */
function pushUrl() {
  if (process.env.SHOPEE_PUSH_URL) return process.env.SHOPEE_PUSH_URL;
  const base = process.env.BACKEND_URL || '';
  return `${base}/api/webhooks/shopee`;
}

/**
 * Verify a Shopee push signature.
 *
 * Shopee signs `<push_url>|<raw_body>` with the partner key (HMAC-SHA256, hex)
 * and sends the result in the Authorization header.
 *
 * Fails closed: an unverified push is rejected rather than processed. The cost
 * of a wrong reject is a delayed order (polling still picks it up); the cost of a
 * wrong accept is letting anyone on the internet drive this endpoint.
 *
 * @param {Buffer} rawBody
 * @param {string} signature - Authorization header value
 * @returns {boolean}
 */
function verifySignature(rawBody, signature) {
  const partnerKey = process.env.SHOPEE_PARTNER_KEY;
  if (!partnerKey) {
    console.error('[webhook] SHOPEE_PARTNER_KEY is not set — cannot verify push signatures');
    return false;
  }
  if (!signature) return false;

  const base = `${pushUrl()}|${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', partnerKey).update(base).digest('hex');

  const received = String(signature).trim();

  // timingSafeEqual throws on a length mismatch, so compare lengths first
  if (received.length !== expected.length) {
    console.warn(`[webhook] Signature length mismatch (got ${received.length}, expected ${expected.length}) — check that SHOPEE_PUSH_URL matches the Partner Console entry exactly`);
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Queue a debounced sync for a shop.
 *
 * Never throws: a push must be acknowledged even when the queue is unavailable,
 * because Shopee retries failures and can disable a Push URL that keeps erroring.
 * A dropped enqueue is covered by the scheduled sync.
 *
 * @param {string} storeId
 * @param {string} reason - For the log line only
 */
async function queueSync(storeId, reason) {
  if (!isRedisReady()) {
    console.warn(`[webhook] Redis unavailable — dropping push-triggered sync for store ${storeId}; the scheduled sync will cover it`);
    return;
  }

  try {
    await syncQueue.add(
      'sync-store',
      { storeId, trigger: 'push' },
      {
        jobId: `push-sync-${storeId}`,
        delay: PUSH_DEBOUNCE_MS,
        removeOnComplete: true,
        removeOnFail: { count: 20 },
      },
    );
    console.log(`[webhook] Queued sync for store ${storeId} (${reason})`);
  } catch (err) {
    console.warn(`[webhook] Could not queue sync for store ${storeId}: ${err.message}`);
  }
}

/**
 * POST /api/webhooks/shopee
 *
 * Acknowledges with 200 as soon as the signature checks out; the actual work
 * happens on the queue. Shopee expects a prompt response and retries slow or
 * failed deliveries.
 */
router.post('/shopee', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  if (!verifySignature(rawBody, req.headers.authorization)) {
    console.warn('[webhook] Rejected push with invalid signature');
    return res.status(401).json({ success: false, error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.warn(`[webhook] Rejected push with unparseable body: ${err.message}`);
    return res.status(400).json({ success: false, error: 'Invalid JSON' });
  }

  const code = payload.code;
  const shopId = payload.shop_id != null ? String(payload.shop_id) : null;

  console.log(`[webhook] Shopee push code=${code} shop_id=${shopId || 'n/a'}`);

  // Acknowledge before doing any work: the rest is best-effort and must not keep
  // Shopee waiting or turn a local hiccup into a delivery failure.
  res.status(200).json({ success: true });

  if (!shopId) {
    console.warn(`[webhook] Push code=${code} carried no shop_id — nothing to act on`);
    return;
  }

  try {
    const store = await prisma.store.findFirst({
      where: { platform: 'SHOPEE', shopId },
      select: { id: true, name: true, isActive: true },
    });

    if (!store) {
      console.warn(`[webhook] Push for unknown shop_id=${shopId} — not connected here, ignoring`);
      return;
    }

    switch (code) {
      case EVENT.ORDER_STATUS:
      case EVENT.TRACKING_NUMBER:
        if (!store.isActive) {
          console.log(`[webhook] Store ${store.id} is deactivated — ignoring push code=${code}`);
          return;
        }
        await queueSync(store.id, `push code=${code}`);
        break;

      case EVENT.SHOP_DEAUTHORIZED:
        // The merchant revoked access. Flagging it stops the token sweep from
        // retrying a connection that cannot recover without re-authorization, and
        // surfaces the state in the UI. The store is left active on purpose —
        // deactivating it would hide its orders from staff.
        console.warn(`[webhook] Shop ${shopId} (${store.name}) deauthorized — flagging for reconnect`);
        await prisma.store.update({
          where: { id: store.id },
          data: { needsReconnect: true },
        });
        break;

      case EVENT.SHOP_AUTHORIZED:
        // The OAuth callback already handles this; the push is informational.
        console.log(`[webhook] Shop ${shopId} authorization push received`);
        break;

      default:
        console.log(`[webhook] Unhandled push code=${code} for shop ${shopId} — acknowledged, no action`);
    }
  } catch (err) {
    console.error(`[webhook] Error handling push code=${code} shop=${shopId}: ${err.message}`);
  }
});

module.exports = router;
