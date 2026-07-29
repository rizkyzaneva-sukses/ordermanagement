'use strict';

/**
 * barcode.js — Code 128 encoder producing bar/space module runs for pdf-lib.
 *
 * Couriers scan the AWB barcode, so a plain-text tracking number on a label is
 * not machine-readable. This renders the same number as Code 128, the symbology
 * Shopee's own waybills use.
 *
 * Two subsets are emitted:
 *   Code 128C for an even-length all-digit payload — encodes two digits per
 *              symbol, halving the width and roughly doubling the module size
 *              available within a 10 cm label.
 *   Code 128B otherwise — one symbol per character, covers alphanumerics.
 *
 * IMPORTANT: the pattern table below is transcribed from the Code 128
 * specification. The encoder is unit-tested for structural correctness and
 * check-digit arithmetic, but a printed label must still be verified against a
 * real scanner before it is used in production.
 */

/**
 * Module-width patterns for symbol values 0–106.
 *
 * Each entry is a run-length sequence starting with a bar and alternating
 * bar/space; every symbol is 11 modules wide except the 13-module stop pattern.
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
];

const START_B = 104;
const START_C = 105;
const STOP    = 106;

/**
 * Encode text into Code 128 symbol values (start + data + checksum + stop).
 *
 * @param {string} text
 * @returns {{ values: number[], subset: 'B'|'C' }}
 */
function encodeToValues(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('barcode: text must be a non-empty string');
  }

  const useC = /^\d+$/.test(text) && text.length % 2 === 0;
  const values = [useC ? START_C : START_B];

  if (useC) {
    for (let i = 0; i < text.length; i += 2) {
      values.push(parseInt(text.slice(i, i + 2), 10));
    }
  } else {
    for (const char of text) {
      const code = char.charCodeAt(0);
      // Code 128B covers ASCII 32–127; anything else cannot be represented.
      if (code < 32 || code > 127) {
        throw new Error(`barcode: character "${char}" (0x${code.toString(16)}) is not encodable in Code 128B`);
      }
      values.push(code - 32);
    }
  }

  // Checksum: start value + each data value weighted by its 1-based position
  let sum = values[0];
  for (let i = 1; i < values.length; i++) {
    sum += values[i] * i;
  }
  values.push(sum % 103);
  values.push(STOP);

  return { values, subset: useC ? 'C' : 'B' };
}

/**
 * Convert text into drawable bars.
 *
 * Returns bar positions in *modules*, letting the caller scale to whatever
 * width the label allows.
 *
 * @param {string} text
 * @returns {{ bars: Array<{ start: number, width: number }>, totalModules: number, subset: string }}
 */
function encode(text) {
  const { values, subset } = encodeToValues(text);

  const bars = [];
  let position = 0;

  for (const value of values) {
    const pattern = PATTERNS[value];
    // Runs alternate bar, space, bar, space… always starting with a bar
    for (let i = 0; i < pattern.length; i++) {
      const width = Number(pattern[i]);
      if (i % 2 === 0) bars.push({ start: position, width });
      position += width;
    }
  }

  return { bars, totalModules: position, subset };
}

/**
 * Draw a Code 128 barcode onto a pdf-lib page.
 *
 * Silently draws nothing for an unencodable payload — a missing barcode is a
 * better outcome than a failed print run for the whole batch.
 *
 * @param {Object} page - pdf-lib PDFPage
 * @param {Object} options
 * @param {string} options.text
 * @param {number} options.x        - Left edge (pt)
 * @param {number} options.y        - Bottom edge (pt)
 * @param {number} options.width    - Total width to fill (pt)
 * @param {number} options.height   - Bar height (pt)
 * @param {Object} options.rgb      - pdf-lib rgb() helper
 * @returns {{ drawn: boolean, moduleWidth?: number, reason?: string }}
 */
function drawCode128(page, { text, x, y, width, height, rgb }) {
  let encoded;
  try {
    encoded = encode(text);
  } catch (err) {
    console.warn(`[barcode] Skipping barcode for "${text}": ${err.message}`);
    return { drawn: false, reason: err.message };
  }

  const moduleWidth = width / encoded.totalModules;

  for (const bar of encoded.bars) {
    page.drawRectangle({
      x: x + bar.start * moduleWidth,
      y,
      width: bar.width * moduleWidth,
      height,
      color: rgb(0, 0, 0),
    });
  }

  return { drawn: true, moduleWidth, subset: encoded.subset };
}

module.exports = { encode, encodeToValues, drawCode128, PATTERNS };
