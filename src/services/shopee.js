'use strict';

const crypto = require('crypto');

/**
 * Shopee Open Platform API v2 Client for OrderPro
 *
 * Full-featured client covering:
 *   - OAuth token lifecycle (auth URL, exchange, refresh)
 *   - Shop info
 *   - Order management (list, detail, package search/detail, cancellation)
 *   - Logistics (shipping params, ship/mass-ship, retry pickup, tracking)
 *   - Air waybills (parameters, self-print data, create/poll/download)
 *
 * Endpoint semantics follow shopee-order-management-kb.md; the KB section is
 * cited on each method whose behaviour is non-obvious. Split/unsplit order is
 * deliberately not implemented — this app never divides a package.
 *
 * Signature: HMAC-SHA256
 *   message = partner_id + path + timestamp + access_token + shop_id
 *
 * Environment variables required:
 *   SHOPEE_PARTNER_ID   - numeric partner ID
 *   SHOPEE_PARTNER_KEY  - partner key (secret)
 *
 * Base URL: https://partner.shopeemobile.com
 */

class ShopeeService {
  constructor() {
    this.partnerId = parseInt(process.env.SHOPEE_PARTNER_ID, 10);
    this.partnerKey = process.env.SHOPEE_PARTNER_KEY;
    this.baseUrl = 'https://partner.shopeemobile.com';

    if (!this.partnerId || !this.partnerKey) {
      console.error('[ShopeeService] WARN: SHOPEE_PARTNER_ID or SHOPEE_PARTNER_KEY not set in environment');
    }

    console.error('[ShopeeService] Initialized');
  }

  // ──────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────

  /**
   * Generate HMAC-SHA256 signature.
   *
   * @param {string} path         - API path (e.g. /api/v2/order/get_order_list)
   * @param {number} timestamp    - Unix epoch seconds
   * @param {string} [accessToken=''] - Access token (omit for token endpoints)
   * @param {string} [shopId='']      - Shop ID (omit for token endpoints)
   * @returns {string} Hex-encoded signature
   */
  _sign(path, timestamp, accessToken = '', shopId = '') {
    const baseString = `${this.partnerId}${path}${timestamp}${accessToken}${shopId}`;
    const signature = crypto
      .createHmac('sha256', this.partnerKey)
      .update(baseString)
      .digest('hex');

    return signature;
  }

  /**
   * Build the full request URL with authentication query parameters.
   *
   * @param {string} path
   * @param {Object} [params={}]    - Extra query parameters
   * @param {string} [accessToken='']
   * @param {string} [shopId='']
   * @returns {string}
   */
  _buildUrl(path, params = {}, accessToken = '', shopId = '') {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this._sign(path, timestamp, accessToken, shopId);

    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('partner_id', String(this.partnerId));
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', sign);

    if (accessToken) url.searchParams.set('access_token', accessToken);
    if (shopId) url.searchParams.set('shop_id', String(shopId));

    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });

    return url.toString();
  }

  /**
   * Execute an HTTP request against the Shopee API.
   *
   * Includes automatic retry for transient server errors (5xx) up to 3 attempts
   * with exponential back-off.
   *
   * @param {string} method         - HTTP method (GET | POST)
   * @param {string} path           - API path
   * @param {Object} [params={}]    - Query parameters
   * @param {Object|null} [body=null] - JSON body (for POST)
   * @param {string} [accessToken='']
   * @param {string} [shopId='']
   * @returns {Promise<Object>} Parsed JSON response
   * @throws {Error} On API-level or network errors
   */
  async _request(method, path, params = {}, body = null, accessToken = '', shopId = '') {
    const BASE_DELAY_MS = 500;
    // Node's fetch has no default timeout — a Shopee response that never arrives
    // (as opposed to one that errors) would otherwise hang this call, the route
    // handler awaiting it, and the browser spinner on the other end, forever.
    // There is nothing in this codebase upstream that imposes a limit either.
    const REQUEST_TIMEOUT_MS = 30_000;

    // Auth endpoints trade in single-use credentials: /auth/token/get consumes the
    // authorization code, and /auth/access_token/get consumes the refresh token
    // and issues a rotated one. If Shopee processed the call but the response was
    // lost on the way back, a retry replays a credential the platform has already
    // burned — answered with error_not_found, which we read as "needs
    // re-authorization". One transient blip would then force the merchant to
    // reconnect by hand. Failing fast keeps the credential intact for the next
    // scheduled attempt.
    const isAuthEndpoint = path.startsWith('/api/v2/auth/');
    const MAX_RETRIES = isAuthEndpoint ? 1 : 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const url = this._buildUrl(path, params, accessToken, shopId);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      };
      if (body) {
        options.body = JSON.stringify(body);
      }

      console.error(`[ShopeeService._request] ${method} ${path} attempt=${attempt}/${MAX_RETRIES}`);

      const t0 = Date.now();
      let response;
      try {
        response = await fetch(url, options);
      } catch (networkErr) {
        const isTimeout = networkErr.name === 'AbortError';
        const label = isTimeout ? `no response within ${REQUEST_TIMEOUT_MS}ms` : networkErr.message;
        console.error(`[ShopeeService._request] Network error on attempt ${attempt}: ${label}`);
        if (attempt === MAX_RETRIES) {
          throw isTimeout ? new Error(`Shopee API: ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`) : networkErr;
        }
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.error(`[ShopeeService._request] Retrying in ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      } finally {
        clearTimeout(timer);
      }

      const elapsed = Date.now() - t0;
      console.error(`[ShopeeService._request] Response status=${response.status} elapsed=${elapsed}ms`);

      // Read body as text first so we can log raw on parse failure
      const raw = await response.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        console.error(`[ShopeeService._request] JSON parse error: ${parseErr.message}`);
        throw new Error(`Shopee API: invalid JSON response – ${parseErr.message}`);
      }

      console.error(`[ShopeeService._request] Parsed response: error=${data.error || 'none'} message=${data.message || 'none'} request_id=${data.request_id || 'n/a'}`);

      // Shopee API-level errors
      if (data.error) {
        const errMsg = `Shopee API Error: ${data.error} – ${data.message || 'no message'} (request_id=${data.request_id || 'n/a'})`;
        console.error(`[ShopeeService._request] ${errMsg}`);

        // Some Shopee errors are transient (e.g. system_error, db_error)
        const retryableErrors = ['system_error', 'db_error', 'service_temporarily_unavailable'];
        if (retryableErrors.includes(data.error) && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.error(`[ShopeeService._request] Retryable error "${data.error}", retrying in ${delay}ms…`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        throw new Error(errMsg);
      }

      console.error(`[ShopeeService._request] Success for ${path} (attempt ${attempt})`);
      return data;
    }

    // Should never reach here, but just in case
    throw new Error(`Shopee API: exhausted ${MAX_RETRIES} retries for ${path}`);
  }

  /**
   * Execute a request that returns a binary document rather than JSON.
   *
   * `download_shipping_document` returns the AWB itself — PDF for most markets,
   * HTML for TW C2C and several TW B2C channels, ZIP when the shop is set to
   * thermal printing (KB §7.2). On failure Shopee still answers with a JSON
   * error body, so we sniff the payload before deciding how to treat it.
   *
   * @returns {Promise<{ buffer: Buffer, format: 'pdf'|'html'|'zip'|'unknown', contentType: string }>}
   */
  async _requestBinary(method, path, params = {}, body = null, accessToken = '', shopId = '') {
    const url = this._buildUrl(path, params, accessToken, shopId);

    // Same rationale as _request(): fetch does not time out on its own, and a
    // document endpoint that never answers would otherwise hang the caller
    // (label printing) indefinitely rather than surfacing an error.
    const REQUEST_TIMEOUT_MS = 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const options = { method, headers: { 'Content-Type': 'application/json' }, signal: controller.signal };
    if (body) options.body = JSON.stringify(body);

    console.error(`[ShopeeService._requestBinary] ${method} ${path}`);

    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Shopee API: ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const contentType = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());

    // Shopee reports errors as JSON even on binary endpoints
    if (contentType.includes('application/json')) {
      let data;
      try {
        data = JSON.parse(buffer.toString('utf8'));
      } catch {
        throw new Error(`Shopee API: expected document but got unparseable JSON from ${path}`);
      }
      if (data.error) {
        throw new Error(`Shopee API Error: ${data.error} – ${data.message || 'no message'} (request_id=${data.request_id || 'n/a'})`);
      }
      throw new Error(`Shopee API: expected document but got JSON from ${path}`);
    }

    const format = this._detectDocumentFormat(buffer, contentType);
    console.error(`[ShopeeService._requestBinary] Got ${buffer.length} bytes, format=${format} content_type=${contentType}`);

    return { buffer, format, contentType };
  }

  /**
   * Detect AWB file format from magic bytes, falling back to content-type.
   *
   * KB §7.2 is explicit that the agent must not assume PDF.
   *
   * @param {Buffer} buffer
   * @param {string} [contentType='']
   * @returns {'pdf'|'html'|'zip'|'unknown'}
   */
  _detectDocumentFormat(buffer, contentType = '') {
    if (buffer.length >= 4) {
      const magic = buffer.subarray(0, 4);
      if (magic.toString('latin1') === '%PDF') return 'pdf';
      // ZIP: "PK\x03\x04" (also PK\x05\x06 for an empty archive)
      if (magic[0] === 0x50 && magic[1] === 0x4b) return 'zip';
    }

    const head = buffer.subarray(0, 512).toString('utf8').trim().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';

    if (contentType.includes('pdf')) return 'pdf';
    if (contentType.includes('zip')) return 'zip';
    if (contentType.includes('html')) return 'html';

    return 'unknown';
  }

  /**
   * Poll an async operation with exponential back-off (KB Rule #7 — never tight-loop).
   *
   * @param {Function} fn        - async () => result
   * @param {Function} isDone    - (result) => boolean
   * @param {Object} [opts]
   * @param {number} [opts.maxAttempts=8]
   * @param {number} [opts.baseDelayMs=1000]
   * @param {number} [opts.maxDelayMs=15000]
   * @param {string} [opts.label='operation']
   * @returns {Promise<*>} The first result for which `isDone` returned true
   */
  async _poll(fn, isDone, opts = {}) {
    const maxAttempts = opts.maxAttempts || 8;
    const baseDelayMs = opts.baseDelayMs || 1000;
    const maxDelayMs  = opts.maxDelayMs || 15000;
    const label       = opts.label || 'operation';

    let last;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await fn();
      if (isDone(last)) {
        console.error(`[ShopeeService._poll] ${label} ready after ${attempt} attempt(s)`);
        return last;
      }
      if (attempt === maxAttempts) break;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      console.error(`[ShopeeService._poll] ${label} not ready (attempt ${attempt}/${maxAttempts}), waiting ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }

    const err = new Error(`Shopee API: ${label} did not become ready after ${maxAttempts} attempts`);
    err.lastResult = last;
    err.code = 'POLL_TIMEOUT';
    throw err;
  }

  // ──────────────────────────────────────────────
  // OAuth
  // ──────────────────────────────────────────────

  /**
   * Generate the authorization URL where the merchant logs in and grants
   * permissions to your app.
   *
   * The merchant will be redirected to `redirectUri` with a `code` query
   * parameter you can exchange for tokens via `getToken`.
   *
   * @param {string}        redirectUri - Your callback URL (must be registered in Shopee Partner Console)
   * @param {string|number} [shopId]    - Optional target shop ID (omit to let merchant choose)
   * @returns {string} Full authorization URL
   */
  getAuthUrl(redirectUri, shopId) {
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/shop/auth_partner';
    const sign = this._sign(path, timestamp, '', shopId ? String(shopId) : '');

    let url = `https://partner.shopeemobile.com${path}?partner_id=${this.partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirectUri)}`;
    if (shopId) url += `&shop_id=${shopId}`;

    console.error(`[ShopeeService.getAuthUrl] Generated auth URL redirect=${redirectUri} shop_id=${shopId || '(none)'}`);
    return url;
  }

  /**
   * Exchange an authorization code for access & refresh tokens.
   *
   * After the merchant authorizes, Shopee redirects to your `redirectUri`
   * with a `code` param. Pass that code here.
   *
   * Response includes:
   *   - access_token  (valid ~4 hours)
   *   - refresh_token (valid ~30 days)
   *   - expire_in     (seconds)
   *   - merchant_id
   *   - shop_id
   *
   * @param {string}        code   - Authorization code from redirect
   * @param {string|number} shopId - Shop ID
   * @returns {Promise<Object>}
   */
  async getToken(code, shopId) {
    console.error(`[ShopeeService.getToken] Exchanging code for shop_id=${shopId}`);
    return this._request('POST', '/api/v2/auth/token/get', {}, {
      code,
      shop_id: parseInt(shopId, 10),
      partner_id: this.partnerId,
    });
  }

  /**
   * Refresh an expired access token.
   *
   * Access tokens expire every ~4 hours. Use the refresh_token (valid ~30 days)
   * to obtain a new access + refresh token pair without re-authorization.
   *
   * The endpoint is `/api/v2/auth/access_token/get` — despite the name, this is
   * the refresh call. There is no `/auth/refresh_token/get`; using it returns an
   * error rather than a token pair.
   *
   * `partner_id` is required in the *body* here. The initial exchange
   * (`/auth/token/get`) works without it, so this asymmetry is easy to miss —
   * Shopee answers the omission with "It should have partner_id in the request
   * body."
   *
   * @param {string}        refreshToken - The refresh_token from a previous `getToken` or `refreshToken` call
   * @param {string|number} shopId       - Shop ID
   * @returns {Promise<Object>} New token pair
   */
  async refreshToken(refreshToken, shopId) {
    console.error(`[ShopeeService.refreshToken] Refreshing token for shop_id=${shopId}`);
    return this._request('POST', '/api/v2/auth/access_token/get', {}, {
      refresh_token: refreshToken,
      shop_id: parseInt(shopId, 10),
      partner_id: this.partnerId,
    });
  }

  // ──────────────────────────────────────────────
  // Shop
  // ──────────────────────────────────────────────

  /**
   * Get basic shop information (name, status, region, etc.).
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @returns {Promise<Object>}
   */
  async getShopInfo(accessToken, shopId) {
    console.error(`[ShopeeService.getShopInfo] shop_id=${shopId}`);
    return this._request('GET', '/api/v2/shop/get_shop_info', {}, null, accessToken, String(shopId));
  }

  // ──────────────────────────────────────────────
  // Orders
  // ──────────────────────────────────────────────

  /**
   * Get a paginated list of order IDs filtered by status and time range.
   *
   * Supported order statuses (varies by region):
   *   UNPAID, READY_TO_SHIP, PROCESSED, SHIPPED, COMPLETED,
   *   IN_CANCEL, CANCELLED, INVOICE_PENDING
   *
   * Time range fields: create_time, update_time
   * Max time span: 15 days
   * Max page_size: 100
   *
   * Response contains: response.order_list (each has order_sn + order_status), response.more, response.next_cursor
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {Object} [options={}]
   * @param {string} [options.timeRangeField='create_time']
   * @param {number} options.timeFrom   - Unix epoch (seconds)
   * @param {number} options.timeTo     - Unix epoch (seconds)
   * @param {number} [options.pageSize=50]   - 1–100
   * @param {string} [options.orderStatus='READY_TO_SHIP']
   * @param {string} [options.cursor='']     - Pagination cursor
   * @returns {Promise<Object>}
   */
  async getOrderList(accessToken, shopId, options = {}) {
    const pageSize = Math.min(options.pageSize || 50, 100);

    const params = {
      time_range_field: options.timeRangeField || 'create_time',
      time_from: options.timeFrom,
      time_to: options.timeTo,
      page_size: pageSize,
      order_status: options.orderStatus || 'READY_TO_SHIP',
      cursor: options.cursor || '',
    };

    console.error(`[ShopeeService.getOrderList] shop=${shopId} status=${params.order_status} range=${params.time_from}→${params.time_to} page_size=${params.page_size} cursor=${params.cursor || '(none)'}`);

    return this._request('GET', '/api/v2/order/get_order_list', params, null, accessToken, String(shopId));
  }

  /**
   * Get detailed information for up to 50 orders per call.
   *
   * Response includes line items, shipping address, payment info, etc.
   *
   * @param {string}   accessToken
   * @param {string|number} shopId
   * @param {string[]} orderSnList - Array of order SNs (max 50)
   * @returns {Promise<Object>}
   */
  async getOrderDetail(accessToken, shopId, orderSnList, extraParams = {}) {
    if (!Array.isArray(orderSnList) || orderSnList.length === 0) {
      throw new Error('orderSnList must be a non-empty array');
    }
    if (orderSnList.length > 50) {
      console.error(`[ShopeeService.getOrderDetail] WARN: orderSnList has ${orderSnList.length} items, Shopee max is 50. Only first 50 will be used.`);
      orderSnList = orderSnList.slice(0, 50);
    }

    console.error(`[ShopeeService.getOrderDetail] shop=${shopId} orders=${orderSnList.join(',')}`);

    return this._request('GET', '/api/v2/order/get_order_detail', {
      order_sn_list: orderSnList.join(','),
      // note: buyer catatan ke seller; payment_method: deteksi COD
      response_optional_fields: 'buyer_username,recipient_address,item_list,package_list,shipping_carrier,actual_shipping_cost,tracking_number,note,payment_method',
      ...extraParams,
    }, null, accessToken, String(shopId));
  }

  /**
   * List packages awaiting fulfillment.
   *
   * This is the KB-preferred entry point for the fulfillment flow (Rule #4) —
   * `get_shipment_list` is deprecated, and unlike `get_order_list` this returns
   * the `package_number` needed to act on a single package of a split order.
   *
   * Package status filter (KB §3.1):
   *   0 = All, 1 = Pending, 2 = ToProcess, 3 = Processed
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {Object} [options={}]
   * @param {number} [options.packageStatus=2] - Defaults to ToProcess (ready to ship)
   * @param {number} [options.pageSize=50]     - 1–100
   * @param {string} [options.cursor='']
   * @returns {Promise<Object>} response.package_list / response.more / response.next_cursor
   */
  async searchPackageList(accessToken, shopId, options = {}) {
    const pageSize = Math.min(options.pageSize || 50, 100);
    const packageStatus = options.packageStatus ?? 2;

    console.error(`[ShopeeService.searchPackageList] shop=${shopId} package_status=${packageStatus} page_size=${pageSize} cursor=${options.cursor || '(none)'}`);

    const body = {
      page_size: pageSize,
      cursor: options.cursor || '',
      filter: { package_status: packageStatus },
    };
    if (options.logisticsChannelId) {
      body.filter.logistics_channel_id = options.logisticsChannelId;
    }

    return this._request('POST', '/api/v2/order/search_package_list', {}, body, accessToken, String(shopId));
  }

  /**
   * Fetch all packages for a given package status, auto-paginating.
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {number} [packageStatus=2]
   * @returns {Promise<Array<{ order_sn: string, package_number: string }>>}
   */
  async getAllPackages(accessToken, shopId, packageStatus = 2) {
    const all = [];
    let cursor = '';
    let page = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      page++;
      const result = await this.searchPackageList(accessToken, shopId, {
        packageStatus,
        pageSize: 100,
        cursor,
      });

      const list = result.response?.package_list || [];
      all.push(...list);
      console.error(`[ShopeeService.getAllPackages] Page ${page}: ${list.length} package(s) (total ${all.length})`);

      if (!result.response?.more || !list.length) break;
      cursor = result.response?.next_cursor || '';
      if (!cursor) break;
    }

    return all;
  }

  /**
   * Get detail for one or more packages.
   *
   * KB Rule #1: call this before any write action so the fulfillment status is
   * read from the API rather than guessed from a stale local row.
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {string[]} packageNumberList - Max 50
   * @returns {Promise<Object>}
   */
  async getPackageDetail(accessToken, shopId, packageNumberList) {
    if (!Array.isArray(packageNumberList) || packageNumberList.length === 0) {
      throw new Error('packageNumberList must be a non-empty array');
    }
    if (packageNumberList.length > 50) {
      console.error(`[ShopeeService.getPackageDetail] WARN: ${packageNumberList.length} packages requested, Shopee max is 50. Truncating.`);
      packageNumberList = packageNumberList.slice(0, 50);
    }

    console.error(`[ShopeeService.getPackageDetail] shop=${shopId} packages=${packageNumberList.join(',')}`);

    return this._request('GET', '/api/v2/order/get_package_detail', {
      package_number_list: packageNumberList.join(','),
    }, null, accessToken, String(shopId));
  }

  /**
   * Cancel an order as the seller.
   *
   * Only `OUT_OF_STOCK` and `UNDELIVERABLE_AREA` are valid seller-initiated
   * reasons (KB §10.1). `OUT_OF_STOCK` additionally requires the affected items.
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {string} orderSn
   * @param {'OUT_OF_STOCK'|'UNDELIVERABLE_AREA'} cancelReason
   * @param {Array<{item_id:number, model_id:number}>} [itemList] - Required for OUT_OF_STOCK
   * @returns {Promise<Object>}
   */
  async cancelOrder(accessToken, shopId, orderSn, cancelReason, itemList) {
    const VALID_REASONS = ['OUT_OF_STOCK', 'UNDELIVERABLE_AREA'];
    if (!VALID_REASONS.includes(cancelReason)) {
      throw new Error(`cancelReason must be one of ${VALID_REASONS.join(' | ')}, got "${cancelReason}"`);
    }
    if (cancelReason === 'OUT_OF_STOCK' && (!Array.isArray(itemList) || itemList.length === 0)) {
      throw new Error('itemList is required when cancelReason is OUT_OF_STOCK');
    }

    console.error(`[ShopeeService.cancelOrder] shop=${shopId} order=${orderSn} reason=${cancelReason}`);

    const body = { order_sn: orderSn, cancel_reason: cancelReason };
    if (cancelReason === 'OUT_OF_STOCK') body.item_list = itemList;

    return this._request('POST', '/api/v2/order/cancel_order', {}, body, accessToken, String(shopId));
  }

  /**
   * Approve or reject a buyer's cancellation request (order status `IN_CANCEL`).
   *
   * Note the KB §2.2 branch: not responding is equivalent to approving, so a
   * reject must be sent explicitly and in time.
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {string} orderSn
   * @param {'ACCEPT'|'REJECT'} operation
   * @returns {Promise<Object>}
   */
  async handleBuyerCancellation(accessToken, shopId, orderSn, operation) {
    const VALID_OPERATIONS = ['ACCEPT', 'REJECT'];
    if (!VALID_OPERATIONS.includes(operation)) {
      throw new Error(`operation must be one of ${VALID_OPERATIONS.join(' | ')}, got "${operation}"`);
    }

    console.error(`[ShopeeService.handleBuyerCancellation] shop=${shopId} order=${orderSn} operation=${operation}`);

    return this._request('POST', '/api/v2/order/handle_buyer_cancellation', {}, {
      order_sn: orderSn,
      operation,
    }, accessToken, String(shopId));
  }

  /**
   * Divide an order into several packages.
   *
   * Only valid while the order is `READY_TO_SHIP`, and the request must list
   * every item on the order across at least two packages (KB §6). Splitting is
   * a shop-level permission — a `"You don't have the permission to split order."`
   * error means it has to be requested from Shopee, not retried.
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {string}        orderSn
   * @param {Array<{item_list: Array<Object>}>} packageList - At least 2 entries
   * @returns {Promise<Object>}
   */
  async splitOrder(accessToken, shopId, orderSn, packageList) {
    if (!Array.isArray(packageList) || packageList.length < 2) {
      throw new Error('splitOrder needs at least 2 packages (KB §6 rule 5)');
    }

    console.error(`[ShopeeService.splitOrder] shop=${shopId} order=${orderSn} packages=${packageList.length}`);

    return this._request('POST', '/api/v2/order/split_order', {}, {
      order_sn: orderSn,
      package_list: packageList,
    }, accessToken, String(shopId));
  }

  /**
   * Undo a split, merging the packages back into one.
   *
   * Only possible while the order is still `READY_TO_SHIP`; once any parcel has
   * shipped the split is permanent (KB §6 rule 7).
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {string}        orderSn
   * @returns {Promise<Object>}
   */
  async unsplitOrder(accessToken, shopId, orderSn) {
    console.error(`[ShopeeService.unsplitOrder] shop=${shopId} order=${orderSn}`);

    return this._request('POST', '/api/v2/order/unsplit_order', {}, {
      order_sn: orderSn,
    }, accessToken, String(shopId));
  }

  /**
   * Get available shipping/logistics channels and parameters for an order.
   *
   * Call this before `shipOrder`: its `info_needed` tells you which shipping
   * modes the channel accepts, and exactly one of them must be used (KB Rule #2).
   * In TW it also returns `slug`, which is mandatory on the subsequent
   * `ship_order` call (KB §8.1).
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {string}        orderSn
   * @param {string}        [packageNumber] - Required to target one package of a split order
   * @returns {Promise<Object>}
   */
  async getShippingParameter(accessToken, shopId, orderSn, packageNumber) {
    console.error(`[ShopeeService.getShippingParameter] shop=${shopId} order=${orderSn} pkg=${packageNumber || '(default)'}`);

    const params = { order_sn: orderSn };
    if (packageNumber) params.package_number = packageNumber;

    return this._request('GET', '/api/v2/logistics/get_shipping_parameter', params, null, accessToken, String(shopId));
  }

  /**
   * Batch variant of `getShippingParameter`.
   *
   * Shopee only accepts a batch whose orders share the same logistics channel
   * and warehouse (KB §4.2).
   *
   * ⚠️ Currently unused, and the payload below is known to be rejected: Shopee
   * answers "package_list is a required field", so each order entry wants a
   * nested package_list rather than a flat package_number. The exact shape has
   * not been confirmed, so `massArrangeShipment` loops the single-order
   * endpoints instead. Do not wire this back in without verifying it first.
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {Array<{order_sn:string, package_number?:string}>} orderList
   * @returns {Promise<Object>}
   */
  async getMassShippingParameter(accessToken, shopId, orderList) {
    if (!Array.isArray(orderList) || orderList.length === 0) {
      throw new Error('orderList must be a non-empty array');
    }

    console.error(`[ShopeeService.getMassShippingParameter] shop=${shopId} orders=${orderList.length}`);

    return this._request('POST', '/api/v2/logistics/get_mass_shipping_parameter', {}, {
      order_list: orderList,
    }, accessToken, String(shopId));
  }

  /**
   * Arrange shipment for a single package.
   *
   * The payload shape is mode-dependent (KB §5.1) and exactly one mode may be
   * supplied (KB Rule #2):
   *
   *   pickup         → { address_id, pickup_time_id }
   *   dropoff        → {} (the empty object is still mandatory), or channel-specific fields
   *   non_integrated → { tracking_number } — seller supplies their own AWB
   *
   * Passing `slug` nests it inside the mode object, which is what TW channels
   * require (KB §8.1).
   *
   * Resulting state (KB §5.2): order becomes `PROCESSED`; fulfillment becomes
   * `LOGISTICS_REQUEST_CREATED` for pickup/dropoff but jumps straight to
   * `LOGISTICS_PICKUP_DONE` for non_integrated.
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {Object}        options
   * @param {string}        options.orderSn
   * @param {string}        [options.packageNumber]
   * @param {'pickup'|'dropoff'|'non_integrated'} options.mode
   * @param {Object}        [options.modeData={}] - Fields for the chosen mode
   * @param {string}        [options.slug]        - Mandatory in TW
   * @returns {Promise<Object>}
   */
  async shipOrder(accessToken, shopId, { orderSn, packageNumber, mode, modeData = {}, slug } = {}) {
    const body = this._buildShipmentBody({ orderSn, packageNumber, mode, modeData, slug });

    console.error(`[ShopeeService.shipOrder] shop=${shopId} order=${orderSn} pkg=${packageNumber || '(default)'} mode=${mode}`);

    return this._request('POST', '/api/v2/logistics/ship_order', {}, body, accessToken, String(shopId));
  }

  /**
   * Re-arrange a failed pickup (order status `RETRY_SHIP`, pickup mode only).
   *
   * Reached via KB §3.3 transition 9 — the 3PL failed to collect and the
   * package sits in `LOGISTICS_PICKUP_RETRY` awaiting a new address/time slot.
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {Object}        options
   * @param {string}        options.orderSn
   * @param {string}        [options.packageNumber]
   * @param {number}        options.addressId
   * @param {string}        options.pickupTimeId
   * @returns {Promise<Object>}
   */
  async updateShippingOrder(accessToken, shopId, { orderSn, packageNumber, addressId, pickupTimeId } = {}) {
    if (!orderSn) throw new Error('orderSn is required for updateShippingOrder');
    if (addressId === undefined || addressId === null) {
      throw new Error('addressId is required for updateShippingOrder');
    }
    if (!pickupTimeId) throw new Error('pickupTimeId is required for updateShippingOrder');

    console.error(`[ShopeeService.updateShippingOrder] shop=${shopId} order=${orderSn} address=${addressId} slot=${pickupTimeId}`);

    const body = {
      order_sn: orderSn,
      pickup: { address_id: addressId, pickup_time_id: String(pickupTimeId) },
    };
    if (packageNumber) body.package_number = packageNumber;

    return this._request('POST', '/api/v2/logistics/update_shipping_order', {}, body, accessToken, String(shopId));
  }

  /**
   * Arrange shipment for many packages in one call.
   *
   * Shopee requires every order in the batch to share the same logistics
   * channel and warehouse (KB §4.2); mixed batches must be split by the caller.
   *
   * ⚠️ Unused — same unverified `package_list` requirement as
   * `getMassShippingParameter` above. See `massArrangeShipment`.
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {Object}        options
   * @param {Array<{orderSn:string, packageNumber?:string}>} options.orders
   * @param {'pickup'|'dropoff'|'non_integrated'} options.mode
   * @param {Object}        [options.modeData={}]
   * @returns {Promise<Object>}
   */
  async massShipOrder(accessToken, shopId, { orders, mode, modeData = {} } = {}) {
    if (!Array.isArray(orders) || orders.length === 0) {
      throw new Error('orders must be a non-empty array');
    }
    this._assertShippingMode(mode);

    console.error(`[ShopeeService.massShipOrder] shop=${shopId} orders=${orders.length} mode=${mode}`);

    const body = {
      order_list: orders.map(o => {
        const entry = { order_sn: o.orderSn };
        if (o.packageNumber) entry.package_number = o.packageNumber;
        return entry;
      }),
      [mode]: { ...modeData },
    };

    return this._request('POST', '/api/v2/logistics/mass_ship_order', {}, body, accessToken, String(shopId));
  }

  /**
   * Fetch the tracking number for a single package.
   *
   * A package can sit in `PROCESSED` with no tracking number yet while the 3PL
   * catches up (KB §9), so callers should treat an empty result as "retry
   * later" rather than an error — see `pollTrackingNumber`.
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {string}        orderSn
   * @param {string}        [packageNumber]
   * @returns {Promise<Object>}
   */
  async getTrackingNumber(accessToken, shopId, orderSn, packageNumber) {
    console.error(`[ShopeeService.getTrackingNumber] shop=${shopId} order=${orderSn} pkg=${packageNumber || '(default)'}`);

    const params = { order_sn: orderSn };
    if (packageNumber) params.package_number = packageNumber;

    return this._request('GET', '/api/v2/logistics/get_tracking_number', params, null, accessToken, String(shopId));
  }

  /**
   * Poll `get_tracking_number` until the 3PL issues one.
   *
   * Returns the tracking number, or `null` if it still has not appeared within
   * the allotted attempts — the caller decides whether that is worth surfacing.
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {string}        orderSn
   * @param {string}        [packageNumber]
   * @param {Object}        [pollOpts]
   * @returns {Promise<string|null>}
   */
  async pollTrackingNumber(accessToken, shopId, orderSn, packageNumber, pollOpts = {}) {
    try {
      const result = await this._poll(
        () => this.getTrackingNumber(accessToken, shopId, orderSn, packageNumber),
        (r) => Boolean(r.response?.tracking_number),
        { label: `tracking number for ${orderSn}`, maxAttempts: 5, ...pollOpts },
      );
      return result.response.tracking_number;
    } catch (err) {
      if (err.code === 'POLL_TIMEOUT') {
        console.error(`[ShopeeService.pollTrackingNumber] No tracking number for ${orderSn} yet — will need a later retry`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Batch variant of `getTrackingNumber`.
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {Array<{order_sn:string, package_number?:string}>} orderList
   * @returns {Promise<Object>}
   */
  async getMassTrackingNumber(accessToken, shopId, orderList) {
    if (!Array.isArray(orderList) || orderList.length === 0) {
      throw new Error('orderList must be a non-empty array');
    }

    console.error(`[ShopeeService.getMassTrackingNumber] shop=${shopId} orders=${orderList.length}`);

    return this._request('POST', '/api/v2/logistics/get_mass_tracking_number', {}, {
      order_list: orderList,
    }, accessToken, String(shopId));
  }

  /**
   * Get 3PL tracking events for a package (status enum in KB §10.4).
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {string}        orderSn
   * @param {string}        [packageNumber]
   * @returns {Promise<Object>}
   */
  async getTrackingInfo(accessToken, shopId, orderSn, packageNumber) {
    console.error(`[ShopeeService.getTrackingInfo] shop=${shopId} order=${orderSn} pkg=${packageNumber || '(default)'}`);

    const params = { order_sn: orderSn };
    if (packageNumber) params.package_number = packageNumber;

    return this._request('GET', '/api/v2/logistics/get_tracking_info', params, null, accessToken, String(shopId));
  }

  /**
   * Validate that exactly one legal shipping mode was chosen (KB Rule #2).
   *
   * @param {string} mode
   */
  _assertShippingMode(mode) {
    const MODES = ['pickup', 'dropoff', 'non_integrated'];
    if (!MODES.includes(mode)) {
      throw new Error(`mode must be exactly one of ${MODES.join(' | ')}, got "${mode}"`);
    }
  }

  /**
   * Build a `ship_order`-shaped body for the chosen mode.
   *
   * Kept separate so `shipOrder` and its callers agree on the KB §5.1 shape.
   */
  _buildShipmentBody({ orderSn, packageNumber, mode, modeData = {}, slug }) {
    if (!orderSn) throw new Error('orderSn is required for shipOrder');
    this._assertShippingMode(mode);

    if (mode === 'non_integrated' && !modeData.tracking_number) {
      throw new Error('modeData.tracking_number is required when mode is non_integrated');
    }
    if (mode === 'pickup' && modeData.address_id === undefined) {
      throw new Error('modeData.address_id is required when mode is pickup');
    }

    const modeBody = { ...modeData };
    // TW channels reject the shipment unless the slug from get_shipping_parameter
    // is echoed back inside the mode object (KB §8.1).
    if (slug) modeBody.slug = slug;

    const body = { order_sn: orderSn, [mode]: modeBody };
    if (packageNumber) body.package_number = packageNumber;

    return body;
  }

  /**
   * Pick exactly one shipping mode from a `get_shipping_parameter` response.
   *
   * Default preference is pickup > dropoff > non_integrated (KB §11). When the
   * channel offers only one mode, that mode is the only valid choice.
   *
   * @param {Object} infoNeeded - `response.info_needed` from get_shipping_parameter
   * @param {string[]} [preference]
   * @returns {string} The chosen mode
   */
  pickShippingMode(infoNeeded, preference = ['pickup', 'dropoff', 'non_integrated']) {
    if (!infoNeeded || typeof infoNeeded !== 'object') {
      throw new Error('info_needed missing from get_shipping_parameter response');
    }

    const available = preference.filter(m => Object.prototype.hasOwnProperty.call(infoNeeded, m));
    if (available.length === 0) {
      throw new Error(`No supported shipping mode in info_needed (got: ${Object.keys(infoNeeded).join(', ') || 'nothing'})`);
    }

    console.error(`[ShopeeService.pickShippingMode] available=[${available.join(', ')}] chose=${available[0]}`);
    return available[0];
  }

  /**
   * Normalize a caller-supplied order list into the `order_list` shape the
   * shipping-document endpoints expect.
   *
   * Accepts either bare order SNs or `{ orderSn, packageNumber, trackingNumber }`
   * objects, so package-aware callers and simple ones can share the same API.
   *
   * @param {Array<string|Object>} orderList
   * @param {string} caller - For log messages
   * @returns {Array<Object>}
   */
  _normalizeDocumentOrderList(orderList, caller) {
    if (!Array.isArray(orderList) || orderList.length === 0) {
      throw new Error('orderList must be a non-empty array');
    }
    if (orderList.length > 50) {
      console.error(`[ShopeeService.${caller}] WARN: ${orderList.length} entries, Shopee max is 50. Truncating.`);
      orderList = orderList.slice(0, 50);
    }

    return orderList.map(entry => {
      if (typeof entry === 'string') return { order_sn: entry };

      const normalized = { order_sn: entry.orderSn || entry.order_sn };
      if (!normalized.order_sn) {
        throw new Error(`${caller}: every entry needs an orderSn`);
      }
      const pkg = entry.packageNumber || entry.package_number;
      if (pkg) normalized.package_number = pkg;
      const tracking = entry.trackingNumber || entry.tracking_number;
      if (tracking) normalized.tracking_number = tracking;
      return normalized;
    });
  }

  /**
   * Get the AWB types a channel supports, plus Shopee's recommendation.
   *
   * Worth calling rather than hardcoding a type: TW channel 30001 refuses AWB
   * printing entirely (KB §8.2), and thermal-configured shops need a different
   * type than paper ones.
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {Array<string|Object>} orderList
   * @returns {Promise<Object>}
   */
  async getShippingDocumentParameter(accessToken, shopId, orderList) {
    const normalized = this._normalizeDocumentOrderList(orderList, 'getShippingDocumentParameter');

    console.error(`[ShopeeService.getShippingDocumentParameter] shop=${shopId} orders=${normalized.length}`);

    return this._request('POST', '/api/v2/logistics/get_shipping_document_parameter', {}, {
      order_list: normalized,
    }, accessToken, String(shopId));
  }

  /**
   * Get the raw AWB field data for self-printed labels (KB §5 step 7a).
   *
   * This is the sanctioned source for a self-designed label — it returns the
   * carrier's own sort codes, routing codes and barcode payload, which cannot
   * be reconstructed from order data alone.
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {Array<string|Object>} orderList
   * @returns {Promise<Object>}
   */
  async getShippingDocumentDataInfo(accessToken, shopId, orderList) {
    const normalized = this._normalizeDocumentOrderList(orderList, 'getShippingDocumentDataInfo');

    console.error(`[ShopeeService.getShippingDocumentDataInfo] shop=${shopId} orders=${normalized.length}`);

    return this._request('POST', '/api/v2/logistics/get_shipping_document_data_info', {}, {
      order_list: normalized,
    }, accessToken, String(shopId));
  }

  /**
   * Request server-side generation of AWBs for up to 50 packages.
   *
   * Async — the documents are built in the background, so poll
   * `getShippingDocumentResult` until `READY` (KB Rule #7) before downloading.
   * Only valid once the order is `PROCESSED` and a tracking number exists
   * (KB §7.3).
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {Array<string|Object>} orderList
   * @param {string} [shippingDocumentType] - Omit to let Shopee use its default
   * @returns {Promise<Object>}
   */
  async createShippingDocument(accessToken, shopId, orderList, shippingDocumentType) {
    const normalized = this._normalizeDocumentOrderList(orderList, 'createShippingDocument');

    if (shippingDocumentType) {
      this._assertDocumentType(shippingDocumentType);
      normalized.forEach(o => { o.shipping_document_type = shippingDocumentType; });
    }

    console.error(`[ShopeeService.createShippingDocument] shop=${shopId} orders=${normalized.length} type=${shippingDocumentType || '(default)'}`);

    return this._request('POST', '/api/v2/logistics/create_shipping_document', {}, {
      order_list: normalized,
    }, accessToken, String(shopId));
  }

  /**
   * Check whether previously requested AWBs have finished generating.
   *
   * Note: Shopee's actual endpoint has a typo in the path
   * ("shippping" with 3 p's) — we preserve it as-is.
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {Array<string|Object>} orderList
   * @returns {Promise<Object>}
   */
  async getShippingDocumentResult(accessToken, shopId, orderList) {
    const normalized = this._normalizeDocumentOrderList(orderList, 'getShippingDocumentResult');

    console.error(`[ShopeeService.getShippingDocumentResult] shop=${shopId} orders=${normalized.length}`);

    // Shopee's docs spell this endpoint "shippping" (three p's), but the live
    // API only answers the conventional spelling — the typo'd path returns
    // `error_not_found`, verified against production on 2026-07-31. The docs'
    // spelling is kept as a fallback in case the endpoint is ever fixed to match
    // them; an unknown path is indistinguishable from "package not found", so
    // trying both keeps a rename from looking like a data problem.
    const PATHS = [
      '/api/v2/logistics/get_shipping_document_result',
      '/api/v2/logistics/get_shippping_document_result',
    ];

    let lastErr;
    for (const path of PATHS) {
      try {
        const resp = await this._request('POST', path, {}, {
          order_list: normalized,
        }, accessToken, String(shopId));

        if (path !== PATHS[0]) {
          console.error(`[ShopeeService.getShippingDocumentResult] NOTE: "${PATHS[0]}" failed but "${path}" worked — reorder PATHS to put this first.`);
        }
        return resp;
      } catch (err) {
        // Only a missing endpoint justifies trying the other spelling; a genuine
        // rejection (package not ready, wrong shop) must surface as-is.
        if (!/error_not_found/i.test(err.message)) throw err;
        console.error(`[ShopeeService.getShippingDocumentResult] "${path}" returned error_not_found — trying next spelling`);
        lastErr = err;
      }
    }

    throw lastErr;
  }

  /**
   * Download generated AWBs as a single document.
   *
   * Fails outright if even one package in the request is not yet `READY`
   * (KB §7.3), so callers should poll first. The returned format varies by
   * market and printer setting — see `_detectDocumentFormat`.
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {Array<string|Object>} orderList
   * @param {string} [shippingDocumentType]
   * @returns {Promise<{ buffer: Buffer, format: string, contentType: string }>}
   */
  async downloadShippingDocument(accessToken, shopId, orderList, shippingDocumentType) {
    const normalized = this._normalizeDocumentOrderList(orderList, 'downloadShippingDocument');

    const body = { order_list: normalized };
    if (shippingDocumentType) {
      this._assertDocumentType(shippingDocumentType);
      body.shipping_document_type = shippingDocumentType;
    }

    console.error(`[ShopeeService.downloadShippingDocument] shop=${shopId} orders=${normalized.length} type=${shippingDocumentType || '(default)'}`);

    return this._requestBinary('POST', '/api/v2/logistics/download_shipping_document', {}, body, accessToken, String(shopId));
  }

  /**
   * Validate an AWB document type against the KB §7.1 enum.
   *
   * @param {string} type
   */
  _assertDocumentType(type) {
    const TYPES = [
      'NORMAL_AIR_WAYBILL',
      'THERMAL_AIR_WAYBILL',
      'NORMAL_JOB_AIR_WAYBILL',
      'THERMAL_JOB_AIR_WAYBILL',
    ];
    if (!TYPES.includes(type)) {
      throw new Error(`shippingDocumentType must be one of ${TYPES.join(' | ')}, got "${type}"`);
    }
  }

  /**
   * Run the whole Shopee-generated AWB flow: choose type → create → poll → download.
   *
   * Implements KB §5 step 7b end to end so callers do not have to reimplement
   * the polling contract each time.
   *
   * @param {string} accessToken
   * @param {string|number} shopId
   * @param {Array<string|Object>} orderList
   * @param {Object} [options={}]
   * @param {string} [options.shippingDocumentType] - Skips the parameter lookup when given
   * @param {Object} [options.pollOpts]
   * @returns {Promise<{ buffer: Buffer, format: string, contentType: string, documentType: string }>}
   */
  async fetchShippingDocument(accessToken, shopId, orderList, options = {}) {
    const normalized = this._normalizeDocumentOrderList(orderList, 'fetchShippingDocument');

    let documentType = options.shippingDocumentType;
    if (!documentType) {
      const paramResp = await this.getShippingDocumentParameter(accessToken, shopId, normalized);
      const suggested = paramResp.response?.result_list?.[0]?.suggest_shipping_document_type;
      documentType = suggested || 'NORMAL_AIR_WAYBILL';
      console.error(`[ShopeeService.fetchShippingDocument] Using document type ${documentType}${suggested ? ' (suggested by Shopee)' : ' (fallback)'}`);
    }

    await this.createShippingDocument(accessToken, shopId, normalized, documentType);

    await this._poll(
      () => this.getShippingDocumentResult(accessToken, shopId, normalized),
      (r) => {
        const results = r.response?.result_list || [];
        // download_shipping_document rejects the whole request unless every
        // package is READY (KB §7.3), so partial readiness is not good enough.
        return results.length > 0 && results.every(x => x.status === 'READY');
      },
      { label: `AWB generation for ${normalized.length} package(s)`, ...(options.pollOpts || {}) },
    );

    const doc = await this.downloadShippingDocument(accessToken, shopId, normalized, documentType);
    return { ...doc, documentType };
  }

  // ──────────────────────────────────────────────
  // Utility: Batch order detail fetcher
  // ──────────────────────────────────────────────

  /**
   * Convenience wrapper that fetches order details in batches of 50.
   *
   * If you have more than 50 order SNs, this splits them into chunks
   * and returns all results merged.
   *
   * @param {string}   accessToken
   * @param {string|number} shopId
   * @param {string[]} orderSnList - Any number of order SNs
   * @returns {Promise<Object[]>} Array of individual get_order_detail responses
   */
  async getOrderDetailBatch(accessToken, shopId, orderSnList) {
    const BATCH_SIZE = 50;
    const results = [];
    const total = orderSnList.length;

    console.error(`[ShopeeService.getOrderDetailBatch] shop=${shopId} total_orders=${total} batch_size=${BATCH_SIZE}`);

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = orderSnList.slice(i, i + BATCH_SIZE);
      console.error(`[ShopeeService.getOrderDetailBatch] Fetching batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(total / BATCH_SIZE)} (${batch.length} orders)`);
      const result = await this.getOrderDetail(accessToken, shopId, batch);
      results.push(result);
    }

    console.error(`[ShopeeService.getOrderDetailBatch] Completed ${results.length} batches`);
    return results;
  }

  // ──────────────────────────────────────────────
  // Utility: Get all orders (auto-paginate)
  // ──────────────────────────────────────────────

  /**
   * Fetch every order entry in a time range, following the pagination cursor.
   *
   * `getOrderList` returns at most 100 rows and signals the rest with
   * `response.more` plus `response.next_cursor`. A caller that ignores those
   * silently drops everything past the first page — no error, just a short list —
   * so any code that needs a complete picture must use this instead.
   *
   * Returns the raw entries rather than just the SNs because each one also
   * carries `order_status`, which callers need to avoid a second lookup.
   *
   * ⚠️  For large shops this can produce many API calls.
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {Object} options
   * @param {number} options.timeFrom        - Unix epoch (seconds)
   * @param {number} options.timeTo          - Unix epoch (seconds)
   * @param {string} [options.orderStatus='READY_TO_SHIP']
   * @param {string} [options.timeRangeField='create_time']
   * @param {number} [options.maxPages=50]   - Safety valve against a cursor that never terminates
   * @returns {Promise<Array<{ order_sn: string, order_status?: string }>>}
   */
  async getAllOrders(accessToken, shopId, options = {}) {
    const maxPages = options.maxPages || 50;
    const all = [];
    let cursor = '';
    let page = 0;

    console.error(`[ShopeeService.getAllOrders] shop=${shopId} status=${options.orderStatus || 'READY_TO_SHIP'} range=${options.timeFrom}→${options.timeTo}`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      page++;
      const result = await this.getOrderList(accessToken, shopId, {
        ...options,
        cursor,
        pageSize: 100,
      });

      const orderList = result.response?.order_list || [];
      all.push(...orderList);
      console.error(`[ShopeeService.getAllOrders] Page ${page}: got ${orderList.length} order(s) (total ${all.length})`);

      if (!result.response?.more || !orderList.length) break;

      cursor = result.response?.next_cursor || '';
      if (!cursor) break;

      if (page >= maxPages) {
        console.error(`[ShopeeService.getAllOrders] WARNING: stopped at the ${maxPages}-page cap with more results pending — some orders were not fetched`);
        break;
      }
    }

    console.error(`[ShopeeService.getAllOrders] Finished: ${all.length} order(s) across ${page} page(s)`);
    return all;
  }

  /**
   * Fetch all order SNs within a time range, automatically handling pagination.
   *
   * Thin wrapper over `getAllOrders` for callers that only need the identifiers.
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {Object} options - Same as `getAllOrders`
   * @returns {Promise<string[]>} Complete list of order SNs
   */
  async getAllOrderSns(accessToken, shopId, options = {}) {
    const orders = await this.getAllOrders(accessToken, shopId, options);
    return orders.map(o => o.order_sn);
  }

}

module.exports = new ShopeeService();
