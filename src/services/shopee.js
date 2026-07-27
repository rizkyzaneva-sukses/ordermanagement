'use strict';

const crypto = require('crypto');

/**
 * Shopee Open Platform API v2 Client for OrderPro
 *
 * Full-featured client covering:
 *   - OAuth token lifecycle (auth URL, exchange, refresh)
 *   - Shop info
 *   - Order management (list, detail)
 *   - Logistics (shipping params, ship order, shipping documents)
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
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 500;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const url = this._buildUrl(path, params, accessToken, shopId);

      const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
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
        console.error(`[ShopeeService._request] Network error on attempt ${attempt}: ${networkErr.message}`);
        if (attempt === MAX_RETRIES) throw networkErr;
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.error(`[ShopeeService._request] Retrying in ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
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
   * @param {string|number} shopId     - Target shop ID
   * @param {string}        redirectUri - Your callback URL (must be registered in Shopee Partner Console)
   * @returns {string} Full authorization URL
   */
  getAuthUrl(shopId, redirectUri) {
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/auth/token/get';
    const sign = this._sign(path, timestamp);

    const url = `https://partner.shopeemobile.com${path}?partner_id=${this.partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirectUri)}&shop_id=${shopId}`;

    console.error(`[ShopeeService.getAuthUrl] Generated auth URL for shop_id=${shopId} redirect=${redirectUri}`);
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
   * @param {string}        refreshToken - The refresh_token from a previous `getToken` or `refreshToken` call
   * @param {string|number} shopId       - Shop ID
   * @returns {Promise<Object>} New token pair
   */
  async refreshToken(refreshToken, shopId) {
    console.error(`[ShopeeService.refreshToken] Refreshing token for shop_id=${shopId}`);
    return this._request('POST', '/api/v2/auth/refresh_token/get', {}, {
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
   * Response contains: order_sn_list, more, cursor/next_cursor
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
  async getOrderDetail(accessToken, shopId, orderSnList) {
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
    }, null, accessToken, String(shopId));
  }

  /**
   * Get available shipping/logistics channels and parameters for an order.
   *
   * Use this before calling `shipOrder` to determine which logistics provider
   * and options are available.
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {string}        orderSn
   * @returns {Promise<Object>}
   */
  async getShippingParameter(accessToken, shopId, orderSn) {
    console.error(`[ShopeeService.getShippingParameter] shop=${shopId} order=${orderSn}`);
    return this._request('GET', '/api/v2/logistics/get_shipping_parameter', {
      order_sn: orderSn,
    }, null, accessToken, String(shopId));
  }

  /**
   * Ship an order by providing a tracking number.
   *
   * This marks the order as shipped in Shopee's system. The logistics
   * channel must have been set during order creation or via
   * `getShippingParameter`.
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {string}        orderSn
   * @param {string}        [packageNumber=''] - Package number (for multi-package orders)
   * @param {string}        trackingNumber     - Carrier tracking number
   * @returns {Promise<Object>}
   */
  async shipOrder(accessToken, shopId, orderSn, packageNumber = '', trackingNumber) {
    if (!trackingNumber) {
      throw new Error('trackingNumber is required for shipOrder');
    }

    console.error(`[ShopeeService.shipOrder] shop=${shopId} order=${orderSn} pkg=${packageNumber || '(default)'} tracking=${trackingNumber}`);

    return this._request('POST', '/api/v2/logistics/ship_order', {}, {
      order_sn: orderSn,
      package_number: packageNumber,
      tracking_number: trackingNumber,
    }, accessToken, String(shopId));
  }

  /**
   * Request creation of shipping documents (air waybills / labels) for
   * up to 50 orders.
   *
   * This is an async operation — the documents are generated server-side.
   * Poll `getShippingDocumentResult` to check if the documents are ready
   * for download.
   *
   * @param {string}   accessToken
   * @param {string|number} shopId
   * @param {string[]} orderSnList - Array of order SNs (max 50)
   * @returns {Promise<Object>}
   */
  async createShippingDocument(accessToken, shopId, orderSnList) {
    if (!Array.isArray(orderSnList) || orderSnList.length === 0) {
      throw new Error('orderSnList must be a non-empty array');
    }
    if (orderSnList.length > 50) {
      console.error(`[ShopeeService.createShippingDocument] WARN: orderSnList has ${orderSnList.length} items, Shopee max is 50. Truncating.`);
      orderSnList = orderSnList.slice(0, 50);
    }

    console.error(`[ShopeeService.createShippingDocument] shop=${shopId} orders=${orderSnList.join(',')}`);

    return this._request('POST', '/api/v2/logistics/create_shipping_document', {}, {
      order_sn_list: orderSnList.map(sn => ({ order_sn: sn })),
    }, accessToken, String(shopId));
  }

  /**
   * Check the status of previously requested shipping documents.
   *
   * The response indicates which documents are ready for download and
   * which are still processing.
   *
   * Note: Shopee's actual endpoint has a typo in the path
   * ("shippping" with 3 p's) — we preserve it as-is.
   *
   * @param {string}   accessToken
   * @param {string|number} shopId
   * @param {string[]} orderSnList - Array of order SNs (max 50)
   * @returns {Promise<Object>}
   */
  async getShippingDocumentResult(accessToken, shopId, orderSnList) {
    if (!Array.isArray(orderSnList) || orderSnList.length === 0) {
      throw new Error('orderSnList must be a non-empty array');
    }
    if (orderSnList.length > 50) {
      console.error(`[ShopeeService.getShippingDocumentResult] WARN: orderSnList has ${orderSnList.length} items, Shopee max is 50. Truncating.`);
      orderSnList = orderSnList.slice(0, 50);
    }

    console.error(`[ShopeeService.getShippingDocumentResult] shop=${shopId} orders=${orderSnList.join(',')}`);

    return this._request('GET', '/api/v2/logistics/get_shippping_document_result', {
      order_sn_list: orderSnList.join(','),
    }, null, accessToken, String(shopId));
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
   * Fetch all order SNs within a time range, automatically handling pagination.
   *
   * ⚠️  Use with caution — for large shops this can produce many API calls.
   *
   * @param {string}        accessToken
   * @param {string|number} shopId
   * @param {Object} options
   * @param {number} options.timeFrom        - Unix epoch (seconds)
   * @param {number} options.timeTo          - Unix epoch (seconds)
   * @param {string} [options.orderStatus='READY_TO_SHIP']
   * @param {string} [options.timeRangeField='create_time']
   * @returns {Promise<string[]>} Complete list of order SNs
   */
  async getAllOrderSns(accessToken, shopId, options = {}) {
    const allOrders = [];
    let cursor = '';
    let page = 0;

    console.error(`[ShopeeService.getAllOrderSns] shop=${shopId} status=${options.orderStatus || 'READY_TO_SHIP'} range=${options.timeFrom}→${options.timeTo}`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      page++;
      const result = await this.getOrderList(accessToken, shopId, {
        ...options,
        cursor,
        pageSize: 100,
      });

      const snList = result.order_sn_list || [];
      allOrders.push(...snList);
      console.error(`[ShopeeService.getAllOrderSns] Page ${page}: got ${snList.length} orders (total so far: ${allOrders.length})`);

      if (!result.more || !snList.length) break;
      cursor = result.next_cursor || result.cursor || '';
      if (!cursor) break;
    }

    console.error(`[ShopeeService.getAllOrderSns] Finished: ${allOrders.length} total orders across ${page} pages`);
    return allOrders;
  }
}

module.exports = new ShopeeService();
