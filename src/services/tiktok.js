'use strict';

const crypto = require('crypto');

class TiktokService {
  constructor() {
    this.appKey = process.env.TIKTOK_APP_KEY;
    this.appSecret = process.env.TIKTOK_APP_SECRET;
    this.baseUrl = 'https://open-api.tiktokglobalshop.com';
  }

  /**
   * Generate HMAC-SHA256 signature for TikTok Open Platform API v2.
   * Sign string format: app_key{key}path{path}timestamp{ts}
   */
  _sign(path, timestamp) {
    const signString = `app_key${this.appKey}path${path}timestamp${timestamp}`;
    return crypto.createHmac('sha256', this.appSecret).update(signString).digest('hex');
  }

  /**
   * Build full URL with mandatory auth query params (app_key, timestamp, sign)
   * plus any extra params provided.
   */
  _buildUrl(path, params = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this._sign(path, timestamp);
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('app_key', this.appKey);
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', sign);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /**
   * Core HTTP request helper with authentication headers and error handling.
   * @param {string} method - HTTP method
   * @param {string} path   - API path (e.g. '/orders/search')
   * @param {Object} params - Query parameters
   * @param {Object|null} body - JSON body (for POST)
   * @param {string} accessToken - Shop access token
   * @returns {Promise<Object>} Parsed response data
   */
  async _request(method, path, params = {}, body = null, accessToken = '') {
    const url = this._buildUrl(path, params);
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-tts-access-token': accessToken || ''
      }
    };
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    console.error(`[TikTok API] ${method} ${path}`);
    const response = await fetch(url, options);
    const data = await response.json();

    if (data.code !== 0 && data.code !== 20000) {
      console.error(`[TikTok API Error] code=${data.code} message=${data.message} path=${path}`);
      throw new Error(`TikTok API Error: ${data.code} - ${data.message}`);
    }

    return data.data || data;
  }

  // ─── OAuth ────────────────────────────────────────────────────────

  /**
   * Build the OAuth authorization URL the merchant must visit to grant access.
   * @param {string} shopId     - Arbitrary state value (typically shop_id)
   * @param {string} redirectUri - Your callback URL
   * @returns {string}
   */
  getAuthUrl(shopId, redirectUri) {
    const url = new URL('https://auth.tiktok-shops.com/authorize');
    url.searchParams.set('app_key', this.appKey);
    url.searchParams.set('state', shopId);
    url.searchParams.set('redirect_uri', redirectUri);
    console.error(`[TikTok OAuth] Auth URL generated for shop ${shopId}`);
    return url.toString();
  }

  /**
   * Exchange an authorization code for access + refresh tokens.
   * @param {string} code - The code returned from the OAuth redirect
   * @returns {Promise<Object>} { access_token, refresh_token, ... }
   */
  async getToken(code) {
    console.error('[TikTok OAuth] Exchanging auth code for token');
    return this._request('POST', '/authorization/token', {}, {
      auth_code: code,
      app_key: this.appKey,
      app_secret: this.appSecret
    });
  }

  /**
   * Refresh an expired access token using a valid refresh token.
   * @param {string} refreshToken
   * @returns {Promise<Object>} { access_token, refresh_token, ... }
   */
  async refreshToken(refreshToken) {
    console.error('[TikTok OAuth] Refreshing access token');
    return this._request('POST', '/authorization/refresh', {}, {
      refresh_token: refreshToken,
      app_key: this.appKey,
      app_secret: this.appSecret
    });
  }

  // ─── Orders ───────────────────────────────────────────────────────

  /**
   * Search / list orders with filtering, sorting, and pagination.
   * @param {string} accessToken
   * @param {Object} options
   * @param {number}  [options.pageSize=50]      - 1–100
   * @param {string}  [options.pageToken='']      - Pagination cursor
   * @param {string}  [options.sortBy='create_time']
   * @param {string}  [options.sortOrder='DESC']
   * @param {number}  [options.orderStatus]       - Status filter
   * @param {number}  [options.createTimeFrom]    - Unix timestamp
   * @param {number}  [options.createTimeTo]      - Unix timestamp
   * @returns {Promise<Object>} { order_list, next_page_token, total_count }
   */
  async searchOrders(accessToken, options = {}) {
    const params = {
      page_size: Math.min(options.pageSize || 50, 100),
      page_token: options.pageToken || '',
      sort_by: options.sortBy || 'create_time',
      sort_order: options.sortOrder || 'DESC'
    };
    if (options.orderStatus !== undefined) params.order_status = options.orderStatus;
    if (options.createTimeFrom !== undefined) params.create_time_from = options.createTimeFrom;
    if (options.createTimeTo !== undefined) params.create_time_to = options.createTimeTo;

    console.error(`[TikTok Orders] Searching orders (page_size=${params.page_size})`);
    return this._request('GET', '/orders/search', params, null, accessToken);
  }

  /**
   * Get full details for up to 50 orders in one call.
   * @param {string}   accessToken
   * @param {string[]} orderIdList - Array of order IDs (max 50)
   * @returns {Promise<Object>} { order_list }
   */
  async getOrderDetail(accessToken, orderIdList) {
    if (!Array.isArray(orderIdList) || orderIdList.length === 0) {
      throw new Error('order_id_list must be a non-empty array');
    }
    if (orderIdList.length > 50) {
      throw new Error('order_id_list supports a maximum of 50 IDs per request');
    }
    console.error(`[TikTok Orders] Fetching details for ${orderIdList.length} order(s)`);
    return this._request('POST', '/orders/detail/query', {}, {
      order_ids: orderIdList
    }, accessToken);
  }

  // ─── Fulfillment / Shipping ───────────────────────────────────────

  /**
   * Retrieve shipping labels for the given orders.
   * @param {string}   accessToken
   * @param {string[]} orderIdList - Array of order IDs
   * @returns {Promise<Object>} Label data / download URLs
   */
  async getShippingLabel(accessToken, orderIdList) {
    if (!Array.isArray(orderIdList) || orderIdList.length === 0) {
      throw new Error('order_id_list must be a non-empty array');
    }
    console.error(`[TikTok Fulfillment] Getting shipping label(s) for ${orderIdList.length} order(s)`);
    return this._request('GET', '/fulfillment/shipping_label', {
      order_ids: orderIdList.join(',')
    }, null, accessToken);
  }

  /**
   * Create / generate a new shipping label (air waybill) for orders.
   * @param {string}   accessToken
   * @param {string[]} orderIdList - Array of order IDs
   * @returns {Promise<Object>} Created label data
   */
  async createShippingLabel(accessToken, orderIdList) {
    if (!Array.isArray(orderIdList) || orderIdList.length === 0) {
      throw new Error('order_id_list must be a non-empty array');
    }
    console.error(`[TikTok Fulfillment] Creating shipping label(s) for ${orderIdList.length} order(s)`);
    return this._request('POST', '/fulfillment/shipping_label/create', {}, {
      order_ids: orderIdList
    }, accessToken);
  }

  /**
   * Mark an order as shipped with tracking information.
   * @param {string} accessToken
   * @param {string} orderId
   * @param {string} trackingNumber
   * @param {string} shippingProviderId
   * @returns {Promise<Object>}
   */
  async shipOrder(accessToken, orderId, trackingNumber, shippingProviderId) {
    if (!orderId || !trackingNumber || !shippingProviderId) {
      throw new Error('orderId, trackingNumber, and shippingProviderId are all required');
    }
    console.error(`[TikTok Fulfillment] Shipping order ${orderId} (tracking=${trackingNumber})`);
    return this._request('POST', '/fulfillment/order_ship', {}, {
      order_id: orderId,
      tracking_number: trackingNumber,
      shipping_provider_id: shippingProviderId
    }, accessToken);
  }

  /**
   * List available shipping providers / carriers.
   * @param {string} accessToken
   * @returns {Promise<Object>} { shipping_provider_list }
   */
  async getShippingProviders(accessToken) {
    console.error('[TikTok Fulfillment] Fetching shipping providers');
    return this._request('GET', '/fulfillment/shipping_provider/list', {}, null, accessToken);
  }
}

module.exports = new TiktokService();
