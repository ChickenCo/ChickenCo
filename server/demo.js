// Sample data for trying the app: the real pick list from Truck 1 / Stop 008 plus a few made-up orders.
// Demo barcodes use the "2" UPC prefix (reserved for in-store use) so they never clash with real products.
const { one, run } = require('./db');
const days = require('./days');

const ITEMS = [
  ['00014', 'STELLA LN 2/12'], ['00125', 'BUD LN 4/6'], ['00171', 'BUD CHEL 15/25OZ'],
  ['00235', 'BUD SELECT 30/12 CAN'], ['00261', 'BUDICE 15/25OZ CAN'], ['00265', 'BUDICE LNNR 2/12'],
  ['00266', 'BUDICE 16OZ 4/6PK'], ['00439', 'MULTRA 24/12 CAN'], ['00442', 'MULTRA 2/12CAN'],
  ['00445', 'MULTRA 15/25OZ'], ['00446', 'MULTRA 18 CAN'], ['00449', 'MULTRA LN 2/12'],
  ['00459', 'MULTRA LM PP 2/12 CN'], ['00547', 'NAT LT DAD 16OZ 4/6'], ['00566', 'NATICE 16OZ 4/6 CAN'],
  ['00693', 'BSH LT 30/12 CAN'], ['00705', 'BLT STRAW-RITA 24/7.5OZ 2/12'], ['00710', 'BLT BRRY RITA 2/12 7.5 OZ'],
  ['00717', 'BUD LT 18/12 CAN'], ['00720', 'BUD LT 12/12 CAN'], ['00735', 'BUD LT 30/12 CAN'],
  ['00772', 'BUD LT CHEL 15/25 OZ'], ['00794', 'BLT LIME LN 4/6'], ['01172', 'NEW BELGIUM VDR JF IPA 4/6'],
];

// Quantities from the paper sheet, in the same order as ITEMS. 01172 was printed *OUT by VIP.
const CHUCKS_QTY = [1, 2, 1, 2, 1, 3, 4, 18, 6, 1, 6, 3, 2, 4, 3, 13, 1, 2, 10, 14, 13, 1, 1, 1];

const ORDERS = [
  {
    load_no: '201', stop: '008', store: "CHUCK'S CARRY OUT", account_no: '', address: '79 WACO DR', city: 'LONDON',
    state: 'KY', day_no: '2', order_date: '10/12/26', zone: '01',
    lines: ITEMS.map(([code], i) => ({ code, qty: CHUCKS_QTY[i], vipOut: code === '01172' })),
  },
  {
    load_no: '201', stop: '009', store: 'MAIN ST MARKET', address: '12 MAIN ST', city: 'LONDON', state: 'KY',
    day_no: '2', order_date: '10/12/26', zone: '01',
    lines: [['00717', 5], ['00735', 8], ['00439', 4], ['00125', 2], ['00693', 6]].map(([code, qty]) => ({ code, qty })),
  },
  {
    load_no: '202', stop: '003', store: 'LAKESIDE PACKAGE', address: '400 LAKE RD', city: 'CORBIN', state: 'KY',
    day_no: '2', order_date: '10/12/26', zone: '01',
    lines: [['00720', 6], ['00442', 3], ['00266', 2], ['00014', 1]].map(([code, qty]) => ({ code, qty })),
  },
  {
    load_no: '203', stop: '001', store: 'HILLTOP GROCERY', address: '9 RIDGE PIKE', city: 'EAST BERNSTADT', state: 'KY',
    day_no: '2', order_date: '10/12/26', zone: '01',
    lines: [['00735', 4], ['00566', 2], ['00710', 1]].map(([code, qty]) => ({ code, qty })),
  },
];

const USERS = [
  ['picker', 'Demo Picker', 'picker', '1111'],
  ['supervisor', 'Demo Supervisor', 'supervisor', '2222'],
  ['manager', 'Demo Manager', 'management', '3333'],
];

function upcCheckDigit(eleven) {
  const sum = [...eleven].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return String((10 - (sum % 10)) % 10);
}

const demoUpc = (code) => { const body = `200000${code.padStart(5, '0')}`; return body + upcCheckDigit(body); };

function insertOrder(o, now) {
  // Demo and test-run orders are flagged so they stay out of pick rates.
  const r = run(`INSERT INTO orders (day_id, is_test, load_no, stop, store, account_no, address, city, state, day_no, order_date, zone, created_at)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  days.openDayId(), o.load_no, o.stop, o.store, o.account_no || '', o.address, o.city, o.state, o.day_no, o.order_date, o.zone, now);
  const id = Number(r.lastInsertRowid);
  o.lines.forEach((l, i) => {
    const desc = ITEMS.find(([c]) => c === l.code)[1];
    run(`INSERT INTO order_lines (order_id, seq, code, description, qty, unit, out_qty, out_reason, out_status, out_at)
      VALUES (?, ?, ?, ?, ?, 'CASES', ?, ?, ?, ?)`,
    id, i, l.code, desc, l.qty, l.vipOut ? l.qty : 0, l.vipOut ? 'vip' : null, l.vipOut ? 'pending' : null, l.vipOut ? now : null);
  });
  run("INSERT INTO events (order_id, type, at) VALUES (?, 'created', ?)", id, now);
  return id;
}

function ensureItems(now) {
  ITEMS.forEach(([code, description]) => {
    run('INSERT INTO items (code, description) VALUES (?, ?) ON CONFLICT(code) DO NOTHING', code, description);
    run(`INSERT INTO item_barcodes (gtin, code, status, created_at) VALUES (?, ?, 'confirmed', ?) ON CONFLICT(gtin) DO NOTHING`,
      demoUpc(code).padStart(14, '0'), code, now);
  });
}

// A fresh copy of the real Chuck's Carry Out pick list on Truck 1, for practice runs.
function addChucksTestRun() {
  const now = Date.now();
  ensureItems(now);
  const d = new Date(now);
  const date = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`;
  const id = insertOrder({ ...ORDERS[0], store: `${ORDERS[0].store} (TEST RUN)`, order_date: date }, now);
  return { id };
}

function load({ hashPin }) {
  const now = Date.now();
  ensureItems(now);
  let users = 0;
  USERS.forEach(([username, name, role, pin]) => {
    if (one('SELECT id FROM users WHERE username = ?', username)) return;
    run('INSERT INTO users (username, name, pin_hash, role, created_at) VALUES (?, ?, ?, ?, ?)', username, name, hashPin(pin), role, now);
    users++;
  });
  ORDERS.forEach((o) => insertOrder(o, now));
  return { items: ITEMS.length, orders: ORDERS.length, users };
}

module.exports = { load, addChucksTestRun, demoUpc, ITEMS, CHUCKS_QTY };
