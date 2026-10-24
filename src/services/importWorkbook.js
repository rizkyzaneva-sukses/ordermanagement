'use strict';

/**
 * importWorkbook.js — the .xlsx files behind Import Master and Import Stok.
 *
 * Only the file format lives here: writing a template and reading one back as
 * plain text. What the rows mean is masterImport.js.
 *
 * .xlsx rather than CSV on purpose (PRD-import-xlsx.md): Excel set to Indonesian
 * saves CSV with ";" between columns, and a file that opens fine and imports as
 * one long column is worse than no import at all.
 */

const ExcelJS = require('exceljs');

/** Sheet holding the instructions; never read as data. */
const GUIDE_SHEET = 'Petunjuk';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
const EDIT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
const LOCKED_FONT = { color: { argb: 'FF9CA3AF' } };

/**
 * Build a template workbook.
 *
 * Columns the operator is meant to change get a yellow header; the ID column
 * is grey, to look like something not to touch. SKU columns are formatted as
 * text so Excel keeps "001234" as typed instead of turning it into 1234.
 *
 * @param {{ sheet: string, columns: Array<{key: string, header: string, width: number,
 *   text?: boolean, edit?: boolean, locked?: boolean}>, rows: Array<Object>, guide: string[] }} spec
 * @returns {Promise<Buffer>}
 */
async function buildWorkbook({ sheet, columns, rows, guide }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OrderPro';
  wb.created = new Date();

  const ws = wb.addWorksheet(sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(c => ({
    key: c.key,
    header: c.header,
    width: c.width,
    style: c.text ? { numFmt: '@' } : {},
  }));

  for (const row of rows) {
    const values = {};
    // Text columns are written as strings even when they look numeric, or the
    // cell format alone would not stop a leading zero from being dropped.
    for (const c of columns) {
      const v = row[c.key];
      values[c.key] = v === null || v === undefined ? '' : (c.text ? String(v) : v);
    }
    ws.addRow(values);
  }

  const header = ws.getRow(1);
  columns.forEach((c, i) => {
    if (c.locked) ws.getColumn(i + 1).font = LOCKED_FONT;
    const cell = header.getCell(i + 1);
    cell.fill = c.edit ? EDIT_FILL : HEADER_FILL;
    cell.font = c.locked ? { ...LOCKED_FONT, bold: true } : { bold: true };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const help = wb.addWorksheet(GUIDE_SHEET);
  help.getColumn(1).width = 110;
  guide.forEach((line, i) => {
    const cell = help.getCell(i + 1, 1);
    cell.value = line;
    cell.alignment = { wrapText: true, vertical: 'top' };
    if (i === 0) cell.font = { bold: true, size: 13 };
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * One cell as the text the operator sees.
 *
 * ExcelJS hands back numbers, rich text runs, hyperlinks and formula results as
 * different shapes; an import only ever wants the visible text.
 */
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value.richText)) return value.richText.map(r => r.text).join('');
  if ('result' in value) return cellText(value.result);
  if ('text' in value) return cellText(value.text);
  return '';
}

/**
 * Read the data sheet of an uploaded workbook as rows of text.
 *
 * The data sheet is the first one that is not Petunjuk, so an operator who
 * renamed it in Excel has not broken anything.
 *
 * @param {Buffer} buffer
 * @returns {Promise<Array<{row: number, cells: string[]}>>}
 * @throws {Error} with `status` 400 when the bytes are not an .xlsx
 */
async function readSheet(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    const err = new Error('File tidak bisa dibaca. Pastikan formatnya .xlsx (Excel), bukan .xls atau .csv.');
    err.status = 400;
    throw err;
  }

  const ws = wb.worksheets.find(s => s.name !== GUIDE_SHEET);
  if (!ws) return [];

  const matrix = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells = [];
    for (let i = 1; i <= row.cellCount; i++) cells.push(cellText(row.getCell(i).value));
    matrix.push({ row: rowNumber, cells });
  });
  return matrix;
}

module.exports = { buildWorkbook, readSheet, cellText };
