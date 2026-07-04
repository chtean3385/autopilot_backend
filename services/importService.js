const { parse: parseCsvSync } = require('csv-parse/sync');
const ExcelJS = require('exceljs');
const { XMLParser } = require('fast-xml-parser');

function cellToString(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    return '';
  }
  return String(v).trim();
}

async function parseXlsxBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { columns: [], rows: [] };

  let headers = [];
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    const values = row.values.slice(1); // exceljs row.values is 1-indexed
    if (rowNumber === 1) {
      headers = values.map((v, i) => cellToString(v) || `Column ${i + 1}`);
    } else {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cellToString(values[i]); });
      rows.push(obj);
    }
  });
  return { columns: headers, rows };
}

function parseCsvBuffer(buffer) {
  const records = parseCsvSync(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  });
  const columns = records.length > 0 ? Object.keys(records[0]) : [];
  return { columns, rows: records };
}

// Legacy "Excel 2003 XML" (SpreadsheetML) export — this is the format Facebook/Meta
// Lead Ads CSV/XLS downloads actually use, despite the .xls extension.
function parseSpreadsheetMLBuffer(buffer) {
  const xml = buffer.toString('utf-8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });
  const doc = parser.parse(xml);
  const workbook = doc.Workbook;
  const worksheet = Array.isArray(workbook.Worksheet) ? workbook.Worksheet[0] : workbook.Worksheet;
  const table = worksheet.Table;
  let rawRows = table.Row;
  if (!rawRows) return { columns: [], rows: [] };
  if (!Array.isArray(rawRows)) rawRows = [rawRows];

  const rowCells = (row) => {
    let cells = row.Cell;
    if (!cells) return [];
    if (!Array.isArray(cells)) cells = [cells];
    const out = [];
    let nextIdx = 0;
    for (const c of cells) {
      const idx = c['@_ss:Index'] ? parseInt(c['@_ss:Index'], 10) - 1 : nextIdx;
      nextIdx = idx + 1;
      let val = c.Data;
      if (val && typeof val === 'object') val = val['#text'] ?? '';
      out[idx] = String(val ?? '').trim();
    }
    return out;
  };

  const headerCells = rowCells(rawRows[0]);
  const columns = headerCells.map((h, i) => h || `Column ${i + 1}`);
  const rows = rawRows.slice(1).map(r => {
    const cells = rowCells(r);
    const obj = {};
    columns.forEach((h, i) => { obj[h] = cells[i] || ''; });
    return obj;
  });
  return { columns, rows };
}

function detectFormat(buffer, originalname) {
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'xlsx'; // PK zip signature
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    throw new Error('Legacy binary .xls format is not supported. Please re-save as .xlsx or .csv (Excel: File > Save As) and re-upload.');
  }
  const head = buffer.slice(0, 4096).toString('utf-8').trimStart();
  if (head.startsWith('<?xml') && /urn:schemas-microsoft-com:office:spreadsheet/.test(head)) return 'spreadsheetml';

  const ext = (originalname.split('.').pop() || '').toLowerCase();
  if (ext === 'xlsx') return 'xlsx';
  return 'csv';
}

async function parseLeadsFile(buffer, originalname) {
  const format = detectFormat(buffer, originalname);
  if (format === 'xlsx') return parseXlsxBuffer(buffer);
  if (format === 'spreadsheetml') return parseSpreadsheetMLBuffer(buffer);
  return parseCsvBuffer(buffer);
}

module.exports = { parseLeadsFile };
