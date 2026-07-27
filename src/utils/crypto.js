'use strict';

const crypto = require('crypto');
const config = require('../config');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // 96-bit IV recommended for GCM
const TAG_LENGTH = 16;      // 128-bit auth tag
const ENCODING = 'hex';
const UTF8 = 'utf8';

/**
 * Derive a 32-byte key from the configured ENCRYPTION_KEY.
 * Supports both raw 32-byte strings and 64-char hex strings.
 */
function getDerivedKey() {
  const raw = config.encryption.key;
  if (!raw) throw new Error('ENCRYPTION_KEY is not configured');

  // If it looks like hex, convert; otherwise hash to get 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns a compact string: iv (hex) + authTag (hex) + ciphertext (hex)
 *
 * @param {string} plaintext - Text to encrypt
 * @returns {string} Encrypted payload (hex-encoded, colon-separated)
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return '';

  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, UTF8),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all hex)
  return [iv.toString(ENCODING), authTag.toString(ENCODING), encrypted.toString(ENCODING)].join(':');
}

/**
 * Decrypt a payload produced by `encrypt()`.
 *
 * @param {string} payload - Encrypted payload (hex, colon-separated)
 * @returns {string} Original plaintext
 */
function decrypt(payload) {
  if (payload == null || payload === '') return '';

  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }

  const [ivHex, tagHex, dataHex] = parts;
  const key = getDerivedKey();
  const iv = Buffer.from(ivHex, ENCODING);
  const authTag = Buffer.from(tagHex, ENCODING);
  const encrypted = Buffer.from(dataHex, ENCODING);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString(UTF8);
}

/**
 * Generate a random hex string of the specified byte length.
 * @param {number} bytes - Number of random bytes (default 32)
 * @returns {string} Hex-encoded random string
 */
function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { encrypt, decrypt, randomHex };
