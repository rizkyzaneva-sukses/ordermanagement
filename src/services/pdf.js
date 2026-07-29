const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const { drawCode128 } = require('./barcode.js');

/**
 * Fields worth surfacing from `get_shipping_document_data_info` (KB §5 step 7a).
 *
 * These are courier routing hints that cannot be derived from order data — the
 * sort code in particular is what the hub uses to route the parcel, so a
 * self-printed label without it is materially worse than the official AWB.
 */
const AWB_DATA_FIELDS = [
  { keys: ['sort_code', 'sortCode'], label: 'SORT CODE', prominent: true },
  { keys: ['routing_code', 'routingCode'], label: 'ROUTE', prominent: true },
  { keys: ['dropoff_code', 'dropoffCode'], label: 'DROPOFF' },
  { keys: ['first_mile_tracking_number', 'firstMileTrackingNumber'], label: 'FIRST MILE' },
];

/** Read the first present key from an AWB data payload. */
function pickAwbField(awbData, keys) {
  if (!awbData) return null;
  for (const key of keys) {
    const value = awbData[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return null;
}

class PdfService {
  constructor() {
    // 10cm x 15cm in points (1cm = 28.346pt)
    this.pageWidth = 283.46;   // 10cm
    this.pageHeight = 425.20;  // 15cm
    this.margin = 14;          // ~5mm
    this.barcodeHeight = 32;
  }

  /**
   * Render a single shipping label.
   *
   * @param {Object} order
   * @param {Object} [awbData] - Entry from get_shipping_document_data_info, when available
   */
  async generateReceipt(order, awbData) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([this.pageWidth, this.pageHeight]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

    const { width, height } = page.getSize();
    let y = height - this.margin;
    const leftX = this.margin;
    const rightX = width - this.margin;
    const contentWidth = width - 2 * this.margin;

    // Draw store name + platform
    page.drawText(order.store?.name || 'Store', { x: leftX, y, font: boldFont, size: 10 });
    y -= 14;
    page.drawText(`[${order.store?.platform || 'SHOPEE'}]`, { x: leftX, y, font, size: 7, color: rgb(0.3, 0.3, 0.3) });

    // Sort code goes top-right where hub staff expect it
    const sortCode = pickAwbField(awbData, ['sort_code', 'sortCode']);
    if (sortCode) {
      const sortWidth = boldFont.widthOfTextAtSize(sortCode, 16);
      page.drawText(sortCode, { x: rightX - sortWidth, y: y - 2, font: boldFont, size: 16 });
    }
    y -= 16;

    // Separator line
    page.drawLine({ start: { x: leftX, y }, end: { x: rightX, y }, thickness: 0.5 });
    y -= 14;

    // Order and package identity — a split order prints several near-identical
    // labels, and the package number is the only thing telling them apart.
    page.drawText(`Pesanan: ${order.orderId || '-'}`, { x: leftX, y, font, size: 7 });
    y -= 10;
    if (order.packageNumber) {
      page.drawText(`Paket: ${order.packageNumber}`, { x: leftX, y, font, size: 7 });
      y -= 10;
    }
    y -= 4;

    // Tracking number + scannable barcode
    page.drawText('NO. RESI:', { x: leftX, y, font, size: 7 });
    y -= 13;
    if (order.trackingNumber) {
      page.drawText(order.trackingNumber, { x: leftX, y, font: boldFont, size: 12 });
      y -= 6;

      y -= this.barcodeHeight;
      drawCode128(page, {
        text: order.trackingNumber,
        x: leftX,
        y,
        width: contentWidth,
        height: this.barcodeHeight,
        rgb,
      });
      y -= 12;
    } else {
      y -= 18;
    }

    // Remaining courier routing hints
    const extraFields = AWB_DATA_FIELDS
      .filter((f) => !f.prominent || f.label !== 'SORT CODE')
      .map((f) => ({ ...f, value: pickAwbField(awbData, f.keys) }))
      .filter((f) => f.value && f.label !== 'SORT CODE');

    for (const field of extraFields) {
      page.drawText(`${field.label}: ${field.value}`, {
        x: leftX, y, font: field.prominent ? boldFont : font, size: field.prominent ? 9 : 7,
      });
      y -= field.prominent ? 12 : 10;
    }

    // Separator
    page.drawLine({ start: { x: leftX, y }, end: { x: rightX, y }, thickness: 0.5 });
    y -= 14;

    // Recipient info
    page.drawText('KEPADA:', { x: leftX, y, font, size: 7 });
    y -= 14;
    page.drawText(order.buyerName || '-', { x: leftX, y, font: boldFont, size: 8 });
    y -= 13;

    // Address with word wrap
    const address = order.buyerAddress || '-';
    const lines = this._wrapText(address, font, 7.5, contentWidth);
    for (const line of lines) {
      if (y < 100) break; // safety
      page.drawText(line, { x: leftX, y, font, size: 7.5 });
      y -= 11;
    }

    if (order.buyerCity) {
      const cityLine = [order.buyerCity, order.buyerProvince, order.buyerPostalCode].filter(Boolean).join(', ');
      page.drawText(cityLine, { x: leftX, y, font, size: 7.5 });
      y -= 11;
    }
    if (order.buyerPhone) {
      page.drawText(`Telp: ${order.buyerPhone}`, { x: leftX, y, font, size: 7.5 });
      y -= 11;
    }
    y -= 8;

    // Separator
    page.drawLine({ start: { x: leftX, y }, end: { x: rightX, y }, thickness: 0.5 });
    y -= 16;

    // Sender
    page.drawText('PENGIRIM:', { x: leftX, y, font, size: 7 });
    y -= 13;
    page.drawText(order.store?.name || '-', { x: leftX, y, font: boldFont, size: 8 });
    y -= 18;

    // Separator
    page.drawLine({ start: { x: leftX, y }, end: { x: rightX, y }, thickness: 0.5 });
    y -= 16;

    // Courier info
    page.drawText(`Kurir: ${order.shippingCourier || '-'} - ${order.shippingService || '-'}`, { x: leftX, y, font: boldFont, size: 8 });
    y -= 13;
    if (order.trackingNumber) {
      page.drawText(`Resi: ${order.trackingNumber}`, { x: leftX, y, font, size: 8 });
    }
    y -= 18;

    // Separator
    page.drawLine({ start: { x: leftX, y }, end: { x: rightX, y }, thickness: 0.5 });
    y -= 14;

    // items is stored as a JSON string in DB — parse it if needed
    let items = order.items;
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch { items = []; }
    }
    if (!Array.isArray(items)) items = [];
    for (let i = 0; i < items.length && y > 60; i++) {
      const item = items[i];
      const itemText = `[${i + 1}] ${item.name || 'Product'} x${item.quantity || 1}`;
      page.drawText(itemText, { x: leftX, y, font, size: 7 });
      if (item.price) {
        const priceText = `Rp${Number(item.price).toLocaleString('id')}`;
        page.drawText(priceText, { x: rightX - font.widthOfTextAtSize(priceText, 7), y, font, size: 7 });
      }
      y -= 12;
    }

    return doc.save();
  }

  /**
   * Render one label per order into a single document.
   *
   * @param {Object[]} orders
   * @param {Map<string, Object>} [awbDataMap] - Keyed by `${orderId}::${packageNumber}`
   */
  async generateBatchPdf(orders, awbDataMap) {
    const doc = await PDFDocument.create();
    for (const order of orders) {
      const key = `${order.orderId}::${order.packageNumber || ''}`;
      const singlePageBytes = await this.generateReceipt(order, awbDataMap?.get(key));
      const singleDoc = await PDFDocument.load(singlePageBytes);
      const [copiedPage] = await doc.copyPages(singleDoc, [0]);
      doc.addPage(copiedPage);
    }
    return doc.save();
  }

  _wrapText(text, font, fontSize, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (font.widthOfTextAtSize(testLine, fontSize) > maxWidth) {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  }
}

module.exports = new PdfService();
