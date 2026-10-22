// Reads orders out of VIP files. Two formats for now:
//  1. The IN005 PICK LIST report saved as text (same layout as the printed sheet).
//  2. A CSV with a header row (load, stop, store, ..., code, description, qty, unit, out).
// This was written from a photo of the printed sheet; it will be tuned against real export files.

const UNIT_COLS = ['CASES', 'BTLS', 'KEGS', 'MISC'];

const clean = (s) => String(s || '').replace(/''/g, "'").replace(/\s+/g, ' ').trim();

// VIP pads fields with "- - - -" leaders; split a line into its real fields.
const fields = (line) => line.split(/\s*(?:-\s){2,}-?\s*|\s{3,}/).map(clean).filter(Boolean);

function parseVipText(text) {
  const warnings = [];
  const src = String(text).replace(/\r/g, '');
  // One report per order: pages are split by form feeds, or by each repeated "PICK LIST" title.
  let chunks = src.split('\f').filter((c) => /PICK LIST/i.test(c));
  if (chunks.length <= 1) {
    const lines = src.split('\n');
    const starts = lines.map((l, i) => (/PICK LIST/i.test(l) ? i : -1)).filter((i) => i >= 0);
    chunks = starts.map((s, k) => {
      // Include the copyright/WHSE line just above the title.
      const from = Math.max(0, s - 1);
      const to = k + 1 < starts.length ? Math.max(from, starts[k + 1] - 1) : lines.length;
      return lines.slice(from, to).join('\n');
    });
  }
  const orders = chunks.map((chunk, n) => parseOne(chunk, n + 1, warnings)).filter(Boolean);
  if (!orders.length) warnings.push('No pick lists were found. Is this the IN005 PICK LIST report?');
  return { orders, warnings };
}

function parseOne(chunk, n, warnings) {
  const lines = chunk.split('\n');
  const find = (re) => { const m = chunk.match(re); return m ? clean(m[1]) : ''; };
  const order = {
    load_no: find(/LOAD\s*#\s*(\d+)/i),
    day_no: find(/DAY\s*#\s*(\d+)/i),
    order_date: find(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/),
    stop: find(/\bSTOP\s+(\w+)/i),
    zone: find(/\bZONE\s+(\w+)/i),
    state: find(/\b([A-Z]{2})\s+STOP\b/),
    city: '', store: '', account_no: '', address: '',
    lines: [],
  };

  const headerIdx = lines.findIndex((l) => /\bCODE\b/.test(l) && /DESCRIPTION/i.test(l));
  if (headerIdx < 0) { warnings.push(`Pick list ${n}: couldn't find the CODE / PRODUCT DESCRIPTION header.`); return null; }
  const header = lines[headerIdx];
  const cols = UNIT_COLS.map((u) => ({ unit: u, at: header.indexOf(u) })).filter((c) => c.at >= 0);
  const codeAt = header.indexOf('CODE');

  // City is the field just before "KY STOP 008".
  const stopLine = lines.find((l) => /\bSTOP\s+\w+/.test(l));
  if (stopLine) {
    const f = fields(stopLine.replace(/\b[A-Z]{2}\s+STOP\b.*$/, ''));
    order.city = f.at(-1) || '';
  }
  // Store line: the last line with letters above the header, e.g. "1237 CHUCK''S CARRY OUT - - 79 WACO DR".
  for (let i = headerIdx - 1; i >= 0; i--) {
    const l = lines[i];
    if (!/[A-Z]{3}/.test(l) || /PICK LIST|STOP|WHSE|DISTRIBUT|Copyright/i.test(l)) continue;
    const f = fields(l.replace(/^[\s\w]*#:?\s*$/, ''));
    if (!f.length) continue;
    const m = f[0].match(/^(\d+)\s+(.+)$/);
    order.account_no = m ? m[1] : '';
    order.store = m ? m[2] : f[0];
    order.address = f[1] || '';
    break;
  }

  for (const raw of lines.slice(headerIdx + 1)) {
    const m = raw.match(/(^|\s)(\d{4,6})\s+(\S.*)$/);
    if (!m) continue;
    const codeStart = raw.indexOf(m[2], m.index);
    if (codeAt >= 0 && Math.abs(codeStart - codeAt) > 12) continue; // a number that isn't in the CODE column
    const left = raw.slice(0, codeStart);
    const vipOut = /\*\s*OUT/i.test(left);
    // Quantities sit under CASES / BTLS / KEGS / MISC; match each number to the nearest column.
    const nums = [...left.matchAll(/\d+/g)].map((x) => ({ qty: Number(x[0]), at: x.index + x[0].length / 2 }));
    const qtys = nums.map((x) => ({
      qty: x.qty,
      unit: cols.length ? cols.reduce((a, b) => (Math.abs(b.at + b.unit.length / 2 - x.at) < Math.abs(a.at + a.unit.length / 2 - x.at) ? b : a)).unit : 'CASES',
    })).filter((x) => x.qty > 0);
    const description = clean(m[3]);
    if (!qtys.length) { warnings.push(`Pick list ${n}: item ${m[2]} (${description}) has no quantity and was skipped.`); continue; }
    qtys.forEach((q) => order.lines.push({ code: m[2], description, qty: q.qty, unit: q.unit, vipOut }));
  }
  if (!order.load_no) warnings.push(`Pick list ${n}: no LOAD# found.`);
  if (!order.store) warnings.push(`Pick list ${n}: store name not found; fill it in before importing.`);
  if (!order.lines.length) warnings.push(`Pick list ${n}: no items found.`);
  return order;
}

// Minimal CSV reader (quotes, commas, tabs).
function csvRows(text) {
  const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const CSV_NAMES = {
  load_no: ['load', 'load#', 'load no', 'load_no'], stop: ['stop'], store: ['store', 'customer', 'store name'],
  account_no: ['account', 'acct', 'account #', 'account_no'], address: ['address'], city: ['city'], state: ['state', 'st'],
  day_no: ['day', 'day#', 'day_no'], order_date: ['date', 'order date'], zone: ['zone'],
  code: ['code', 'item', 'item #', 'item code'], description: ['description', 'product', 'product description'],
  qty: ['qty', 'quantity', 'cases'], unit: ['unit'], out: ['out', '*out', 'vip out'],
};

function parseCsv(text) {
  const rows = csvRows(String(text));
  const warnings = [];
  if (rows.length < 2) return { orders: [], warnings: ['The file has no rows.'] };
  const head = rows[0].map((h) => clean(h).toLowerCase());
  const col = Object.fromEntries(Object.entries(CSV_NAMES).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
  for (const k of ['load_no', 'store', 'code', 'qty']) if (col[k] < 0) warnings.push(`Missing a "${CSV_NAMES[k][0]}" column.`);
  if (warnings.length) return { orders: [], warnings };
  const get = (r, k) => (col[k] >= 0 ? clean(r[col[k]]) : '');
  const byKey = new Map();
  rows.slice(1).forEach((r, i) => {
    const key = [get(r, 'load_no'), get(r, 'stop'), get(r, 'store')].join('|');
    if (!byKey.has(key)) {
      byKey.set(key, { load_no: get(r, 'load_no'), stop: get(r, 'stop'), store: get(r, 'store'), account_no: get(r, 'account_no'),
        address: get(r, 'address'), city: get(r, 'city'), state: get(r, 'state'), day_no: get(r, 'day_no'),
        order_date: get(r, 'order_date'), zone: get(r, 'zone'), lines: [] });
    }
    const qty = Number(get(r, 'qty'));
    if (!get(r, 'code') || !(qty > 0)) { warnings.push(`Row ${i + 2} skipped: needs an item code and a quantity.`); return; }
    byKey.get(key).lines.push({ code: get(r, 'code'), description: get(r, 'description'), qty,
      unit: get(r, 'unit').toUpperCase() || 'CASES', vipOut: /^(y|yes|1|true|\*?out)$/i.test(get(r, 'out')) });
  });
  return { orders: [...byKey.values()], warnings };
}

function parseImport(text, filename = '') {
  const looksCsv = /\.(csv|tsv)$/i.test(filename) || (!/PICK LIST/i.test(text) && /^[^\n]*(,|\t)[^\n]*\n/.test(text));
  return looksCsv ? parseCsv(text) : parseVipText(text);
}

module.exports = { parseImport, parseVipText, parseCsv };
