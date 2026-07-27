const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');

class PdfService {
  constructor() {
    // 10cm x 15cm in points (1cm = 28.346pt)
    this.pageWidth = 283.46;   // 10cm
    this.pageHeight = 425.20;  // 15cm
    this.margin = 14;          // ~5mm
  }

  async generateReceipt(order) {
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
    y -= 16;

    // Separator line
    page.drawLine({ start: { x: leftX, y }, end: { x: rightX, y }, thickness: 0.5 });
    y -= 20;

    // Tracking number (large, bold, scannable area)
    page.drawText('NO. RESI:', { x: leftX, y, font, size: 7 });
    y -= 16;
    if (order.trackingNumber) {
      page.drawText(order.trackingNumber, { x: leftX, y, font: boldFont, size: 14 });
    }
    y -= 24;

    // Separator
    page.drawLine({ start: { x: leftX, y }, end: { x: rightX, y }, thickness: 0.5 });
    y -= 18;

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

    // Items
    const items = Array.isArray(order.items) ? order.items : [];
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

  async generateBatchPdf(orders) {
    const doc = await PDFDocument.create();
    for (const order of orders) {
      const singlePageBytes = await this.generateReceipt(order);
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
