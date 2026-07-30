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
// Codes confirmed against this app's own "Order Push" / "Shopee Push" tables in
// Partner Console → Push Mechanism (Push Code column) — not assumed from
// general docs, since Shopee does not guarantee these numbers are identical
// across every app or region.
const EVENT = {
  // Sent by the Partner Console's "Verify" button, not by a real integration —
  // handled separately, above the signature gate, before this map is ever
  // consulted. Listed here only so the code isn't a mystery number if it shows
  // up in a log.
  VERIFY_PROBE:             0,
  SHOP_AUTHORIZED:          1,
  SHOP_DEAUTHORIZED:        2,
  ORDER_STATUS:             3,
  TRACKING_NUMBER:          4,
  // Fires when a package's logistics_status changes — the field this app
  // stores as Order.logisticsStatus and uses to gate AWB printing (KB §7.3).
  PACKAGE_FULFILLMENT_STATUS: 30,
  // Fires when Shopee finishes generating a requested AWB/shipping label —
  // the async step `createShippingDocument` in shopee.js currently has to be
  // polled for.
  SHIPPING_DOCUMENT_STATUS:  15,
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
/**
 * Candidate ways to build the string Shopee signs. The Partner Console's own
 * "test push" verification is the only oracle for which one is correct — the
 * public docs describe the pieces (URL, body, key) but are not precise enough
 * to bet a single formula on, and a wrong guess fails silently (a signature
 * mismatch looks identical whether it's forged or just computed wrong).
 *
 * `|`-joined is listed first because it matches Shopee's OAuth callback
 * signing convention elsewhere in this codebase — the other three cover the
 * plausible alternatives.
 */
function candidateBases(url, bodyStr) {
  return [
    { label: 'url|body',  value: `${url}|${bodyStr}` },
    { label: 'url+body',  value: `${url}${bodyStr}` },
    { label: 'body only', value: bodyStr },
    { label: 'body|url',  value: `${bodyStr}|${url}` },
  ];
}

function verifySignature(rawBody, signature) {
  // The Partner Console generates a Live Push Partner Key that is distinct from
  // SHOPEE_PARTNER_KEY (the one used to sign outgoing API calls) — pushes are
  // signed with this dedicated key instead. Using the API key here looks
  // reasonable but never verifies against a real push.
  const pushKey = process.env.SHOPEE_PUSH_PARTNER_KEY;
  if (!pushKey) {
    console.error('[webhook] SHOPEE_PUSH_PARTNER_KEY is not set — cannot verify push signatures. This is the "Live Push Partner Key" generated in Partner Console → Push Mechanism, not SHOPEE_PARTNER_KEY.');
    return false;
  }
  if (!signature) return false;

  const url = pushUrl();
  const bodyStr = rawBody.toString('utf8');
  const received = String(signature).trim();

  const candidates = candidateBases(url, bodyStr).map(c => ({
    ...c,
    computed: crypto.createHmac('sha256', pushKey).update(c.value).digest('hex'),
  }));

  const match = candidates.find(c => {
    if (c.computed.length !== received.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(c.computed, 'utf8'));
    } catch {
      return false;
    }
  });

  if (match) {
    if (match.label !== 'url|body') {
      // Verified, but not with the formula the rest of this function defaults
      // to — surfaced loudly because it means `candidateBases` should be
      // reordered to put this formula first, not because anything is wrong.
      console.warn(`[webhook] Signature matched candidate "${match.label}", not the default "url|body". Update candidateBases() to lead with this one.`);
    }
    return true;
  }

  // Every candidate missed. In debug mode, log enough to diagnose by hand:
  // the exact URL and body bytes used (so a stray trailing slash or an
  // unexpected proxy rewrite is visible) and every computed signature next to
  // what Shopee actually sent. None of this is secret — HMAC outputs and a
  // push payload the platform already delivered to us — so it's safe to log
  // whenever this flag is on.
  if (process.env.SHOPEE_PUSH_DEBUG === 'true') {
    console.warn('[webhook] No candidate signature matched. Diagnostic dump follows:');
    console.warn(`[webhook]   url      = ${url}`);
    console.warn(`[webhook]   body     = ${bodyStr}`);
    console.warn(`[webhook]   received = ${received}`);
    for (const c of candidates) {
      console.warn(`[webhook]   ${c.label.padEnd(9)} → ${c.computed}`);
    }
  }

  return false;
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

  // The "Verify" button in Partner Console sends a code=0 probe, not a real
  // push — its body literally instructs "please respond in the certain
  // format." It is parsed and answered *before* the signature gate below: this
  // is Shopee confirming the endpoint is reachable and speaks the right
  // protocol, prior to (and independent of) whatever normally signs a push, so
  // gating it on verifySignature() would make the verification step reject the
  // very probe it exists to answer. Echoing the exact body back is what
  // satisfies it — there is nothing here to act on either way.
  let probePayload;
  try {
    probePayload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    probePayload = null;
  }
  if (probePayload && probePayload.code === 0) {
    console.log('[webhook] Verification probe received — echoing body back');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(rawBody);
  }

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
      case EVENT.PACKAGE_FULFILLMENT_STATUS:
      case EVENT.SHIPPING_DOCUMENT_STATUS:
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
