// Reads orders out of VIP files:
//  1. The VIP "order record" export (Order Details sheet, .xlsx or .csv). This is the main one.
//     It holds every line for every warehouse; only loads whose middle digit is ours are used.
//  2. The IN005 PICK LIST report saved as text (same layout as the printed sheet).
//  3. A simple CSV with a header row (load, stop, store, ..., code, description, qty, unit, out).

const { readXlsx, isXlsx } = require('./xlsx');

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

// ---------- VIP order record export ----------
// Load # is day digit + warehouse digit + truck digit: 101 = day 1, warehouse 0, truck 1.
const loadParts = (load) => {
  const m = String(load).trim().match(/^(\d)(\d)(\d)$/);
  return m ? { day: m[1], warehouse: m[2], truck: Number(m[3]) } : null;
};

const UOM_UNIT = {
  'case beer': 'CASES', 'case non-alcohol': 'CASES', 'case wine': 'CASES', 'case': 'CASES',
  'each wine': 'BTLS', 'each': 'BTLS', 'bottle': 'BTLS',
  'quarter keg': 'KEGS', 'half keg': 'KEGS', 'sixth keg': 'KEGS', 'keg': 'KEGS',
  miscellaneous: 'MISC',
};

const num = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')) || 0);
const txt = (v) => (typeof v === 'number' && Number.isInteger(v) ? String(v) : clean(v));
const vipDate = (d) => { const m = String(d).match(/^(\d{4})(\d{2})(\d{2})$/); return m ? `${m[2]}/${m[3]}/${m[1].slice(2)}` : ''; };

// UPCs come with the leading zero dropped (11 digits) or as full 12/13/14-digit codes.
function upcOf(v) {
  const s = String(v ?? '').replace(/\D/g, '');
  if (s.length === 11) return `0${s}`;
  if (s.length === 8 || (s.length >= 12 && s.length <= 14)) return s;
  return null;
}

const isOrderRecord = (head) => {
  const h = head.map((x) => clean(x).toLowerCase());
  return h.includes('load #') && h.includes('product id') && h.includes('order quantity');
};

function parseOrderRecord(rows, { warehouseDigit = '0' } = {}) {
  const head = rows[0].map((x) => clean(x).toLowerCase());
  const col = (name) => head.indexOf(name.toLowerCase());
  const C = {
    retailer: col('Retailer ID'), store: col('DBA'), code: col('Product ID'), desc: col('Product Description'),
    qty: col('Order Quantity'), invoice: col('Invoice Number'), invoiceDate: col('Invoice Date'), uom: col('Unit of Measure'),
    lineNo: col('Order Line Number'), voided: col('Line Voided?'), upc: col('UPC'), origin: col('Order Origin'),
    load: col('Load #'), stop: col('Stop Number'), picked: col('Picked?'), type: col('Type of Order Line'),
    pricing: col('Pricing Origin'), day: col('Day'),
  };
  for (const k of ['retailer', 'store', 'code', 'desc', 'qty', 'uom', 'load']) {
    if (C[k] < 0) return { orders: [], days: [], barcodes: [], skipped: {}, warnings: [`Missing the "${k}" column. Is this the VIP order record export?`] };
  }
  const get = (r, k) => (C[k] >= 0 ? r[C[k]] : '');
  const skipped = { otherWarehouses: 0, voided: 0, returnsAndCredits: 0, tax: 0, empties: 0 };
  const groups = new Map();
  const upcs = new Map();
  const warnings = [];

  for (const r of rows.slice(1)) {
    const load = txt(get(r, 'load'));
    const lp = loadParts(load);
    if (!lp || lp.warehouse !== String(warehouseDigit)) { skipped.otherWarehouses++; continue; }
    if (clean(get(r, 'voided')).toUpperCase() === 'Y') { skipped.voided++; continue; }
    const retailer = txt(get(r, 'retailer'));
    const key = `${load}|${retailer}`;
    if (!groups.has(key)) {
      groups.set(key, { load_no: load, day_no: lp.day, truck: lp.truck, account_no: retailer, store: clean(get(r, 'store')),
        stops: new Map(), dates: new Set(), dayName: clean(get(r, 'day')), invoices: new Set(), lines: [], messages: new Map() });
    }
    const g = groups.get(key);
    const uom = clean(get(r, 'uom')).toLowerCase();
    const invoice = txt(get(r, 'invoice'));
    const date = vipDate(txt(get(r, 'invoiceDate')));
    if (date) g.dates.add(date);

    // Invoice messages are notes for the delivery ("cooler take to east 80"), split over several lines.
    if (uom === 'invoice message' || num(get(r, 'type')) === 6) {
      const m = g.messages.get(invoice) || [];
      m.push({ n: num(get(r, 'lineNo')), text: clean(get(r, 'desc')) });
      g.messages.set(invoice, m);
      continue;
    }
    if (/^MISC SER CHG/i.test(clean(get(r, 'desc'))) || /^tax$/i.test(clean(get(r, 'origin')))) { skipped.tax++; continue; }
    if (uom === 'returned empty' || uom === 'misc credit/debit') { skipped.empties++; continue; }
    const qty = num(get(r, 'qty'));
    const picked = clean(get(r, 'picked'));
    const stop = num(get(r, 'stop'));
    // Lines VIP doesn't pick are returns, credits and pricing corrections, not product to pull.
    // The one exception: a regular invoice line VIP couldn't pick is a stock-out (*OUT on the sheet).
    const vipOut = picked === '0' && qty > 0 && /invoice pricing/i.test(clean(get(r, 'pricing')));
    if (qty <= 0 || (picked === '0' && !vipOut)) { skipped.returnsAndCredits++; continue; }
    if (stop) g.stops.set(stop, (g.stops.get(stop) || 0) + 1);
    if (invoice && invoice !== '0') g.invoices.add(invoice);
    const code = txt(get(r, 'code')).toUpperCase();
    const description = clean(get(r, 'desc'));
    g.lines.push({ code, description, qty, unit: UOM_UNIT[uom] || 'CASES', vipOut, invoice });
    const upc = upcOf(get(r, 'upc'));
    if (upc && code) {
      if (!upcs.has(upc)) upcs.set(upc, new Map());
      upcs.get(upc).set(code, description);
    }
  }

  const orders = [...groups.values()].filter((g) => g.lines.length).map((g) => {
    const stop = [...g.stops.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const notes = [...new Set([...g.messages.values()].map((m) => m.sort((a, b) => a.n - b.n).map((x) => x.text).join(' ').trim()).filter(Boolean))];
    return {
      load_no: g.load_no, day_no: g.day_no, truck: g.truck, stop: stop ? String(stop).padStart(3, '0') : '',
      store: g.store, account_no: g.account_no, address: '', city: '', state: '', zone: '',
      order_date: [...g.dates].sort().at(-1) || '', dayName: g.dayName,
      invoices: [...g.invoices], notes, lines: g.lines,
      vip_ref: `${g.load_no}:${g.account_no}:${[...g.dates].sort().at(-1) || ''}`,
    };
  }).sort((a, b) => a.load_no.localeCompare(b.load_no) || (parseInt(a.stop, 10) || 0) - (parseInt(b.stop, 10) || 0));
  const empty = groups.size - orders.length;
  if (empty) warnings.push(`${empty} store${empty === 1 ? ' had' : 's had'} nothing to pick (only returns, credits or notes) and ${empty === 1 ? 'was' : 'were'} left out.`);

  // One delivery day per first digit of the load number.
  const days = [...new Set(orders.map((o) => o.day_no))].sort().map((d) => {
    const mine = orders.filter((o) => o.day_no === d);
    return { day_no: d, dayName: mine.find((o) => o.dayName && o.dayName !== 'Unassigned')?.dayName || '',
      date: [...new Set(mine.map((o) => o.order_date))].sort().at(-1) || '',
      loads: [...new Set(mine.map((o) => o.load_no))].sort(), orders: mine.length, cases: mine.reduce((s, o) => s + o.lines.reduce((t, l) => t + l.qty, 0), 0) };
  });
  // A UPC listed under two different items is ambiguous; leave it out.
  const barcodes = [...upcs.entries()].filter(([, codes]) => codes.size === 1)
    .map(([upc, codes]) => { const [[code, description]] = [...codes]; return { upc, code, description }; });
  return { orders, days, barcodes, skipped, warnings, format: 'VIP order record' };
}

// Delivery weekday of an order (0 = Sunday … 6 = Saturday), from its date or else the load's day digit.
function deliveryWeekday(o) {
  const m = String(o.order_date || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(year, Number(m[1]) - 1, Number(m[2])).getDay();
  }
  const d = Number(o.day_no);
  return d >= 1 && d <= 7 ? d % 7 : null;
}

// Kegs are only picked for certain trucks on certain delivery days
// (Perry: Truck 1's Wednesday delivery, picked on Tuesday). No trucks listed = any truck.
// `rule` is { trucks, days } (days are delivery weekdays, 0 = Sunday), or just a list of days.
function applyKegRule(result, rule) {
  const { trucks = [], days: kegDays = [] } = Array.isArray(rule) ? { days: rule } : rule || {};
  const allowedDays = new Set(kegDays);
  const allowedTrucks = new Set(trucks.map(Number));
  let kegs = 0;
  const orders = result.orders.map((o) => {
    const wd = deliveryWeekday(o);
    const truckOk = !allowedTrucks.size || allowedTrucks.has(Number(o.truck));
    if (truckOk && (wd == null || allowedDays.has(wd))) return o;
    const lines = o.lines.filter((l) => l.unit !== 'KEGS');
    kegs += o.lines.length - lines.length;
    return lines.length === o.lines.length ? o : { ...o, lines };
  });
  const kept = orders.filter((o) => o.lines.length);
  const emptied = orders.length - kept.length;
  const warnings = [...(result.warnings || [])];
  if (emptied) warnings.push(`${emptied} order${emptied === 1 ? ' had' : 's had'} only kegs, on a truck or day that doesn't get kegs, and ${emptied === 1 ? 'was' : 'were'} left out.`);
  const days = result.days?.map((d) => {
    const mine = kept.filter((o) => o.day_no === d.day_no);
    return { ...d, orders: mine.length, cases: mine.reduce((s, o) => s + o.lines.reduce((t, l) => t + l.qty, 0), 0) };
  }).filter((d) => d.orders);
  return { ...result, orders: kept, days, warnings, skipped: result.skipped || kegs ? { ...(result.skipped || {}), kegs } : result.skipped };
}

// VIP numbers stops in delivery order, but the truck is loaded last stop first. Per load:
//  - orders of cartMax cases or fewer go on shared carts (several small stores to a cart, up to cartMax cases each);
//  - the remaining (pallet) orders are renumbered in reverse: VIP's last stop becomes Stop 001.
// VIP's own stop number is kept as vip_stop.
function arrangeLoads(orders, { cartMax = 35 } = {}) {
  const cases = (o) => o.lines.filter((l) => !l.vipOut).reduce((s, l) => s + l.qty, 0);
  const byLoad = new Map();
  for (const o of orders) {
    o.vip_stop = o.vip_stop ?? o.stop;
    if (!byLoad.has(o.load_no)) byLoad.set(o.load_no, []);
    byLoad.get(o.load_no).push(o);
  }
  const stopNo = (o) => parseInt(o.vip_stop, 10) || 0;
  for (const list of byLoad.values()) {
    const small = cartMax > 0 ? list.filter((o) => cases(o) <= cartMax) : [];
    const pallets = list.filter((o) => !small.includes(o)).sort((a, b) => stopNo(b) - stopNo(a));
    pallets.forEach((o, i) => { o.stop = String(i + 1).padStart(3, '0'); o.is_cart = false; o.cart_no = null; });
    // First fit, biggest orders first, so as few carts as possible.
    const carts = [];
    for (const o of [...small].sort((a, b) => cases(b) - cases(a) || stopNo(b) - stopNo(a))) {
      const n = cases(o);
      let cart = carts.find((c) => c.cases + n <= cartMax);
      if (!cart) { cart = { cases: 0, orders: [] }; carts.push(cart); }
      cart.cases += n;
      cart.orders.push(o);
    }
    // Cart 1 holds the stops delivered last, like the pallets.
    carts.sort((a, b) => Math.max(...b.orders.map(stopNo)) - Math.max(...a.orders.map(stopNo)));
    carts.forEach((c, i) => c.orders.forEach((o) => { o.stop = ''; o.is_cart = true; o.cart_no = i + 1; }));
  }
  return orders;
}

function parseImport(input, filename = '', opts = {}) {
  if (Buffer.isBuffer(input) && isXlsx(input)) {
    const rows = readXlsx(input);
    if (!rows.length || !isOrderRecord(rows[0])) return { orders: [], warnings: ["This spreadsheet doesn't look like the VIP order record export."] };
    return parseOrderRecord(rows, opts);
  }
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const looksCsv = /\.(csv|tsv)$/i.test(filename) || (!/PICK LIST/i.test(text) && /^[^\n]*(,|\t)[^\n]*\n/.test(text));
  if (looksCsv) {
    const rows = csvRows(text);
    if (rows.length && isOrderRecord(rows[0])) return parseOrderRecord(rows, opts);
    return parseCsv(text);
  }
  return parseVipText(text);
}

module.exports = { arrangeLoads, parseImport, parseVipText, parseCsv, parseOrderRecord, applyKegRule, deliveryWeekday, loadParts, upcOf };
