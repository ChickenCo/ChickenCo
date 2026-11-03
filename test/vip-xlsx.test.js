// VIP order record export (.xlsx): our warehouse's loads only, one order per store per load,
// returns/tax/voided lines left out, invoice messages become notes, UPCs become barcodes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { readXlsx } = require('../server/xlsx');
const { parseImport, upcOf, loadParts } = require('../server/vip');

// Builds a minimal .xlsx (zip of XML) with shared strings, like VIP's export.
function makeXlsx(rows) {
  const strings = [];
  const sIndex = (s) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const colName = (i) => String.fromCharCode(65 + (i % 26)).padStart(i >= 26 ? 2 : 1, String.fromCharCode(64 + Math.floor(i / 26)));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const ref = `${colName(ci)}${ri + 1}`;
    return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="s"><v>${sIndex(String(v))}</v></c>`;
  }).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const sst = `<?xml version="1.0"?><sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  const files = {
    'xl/workbook.xml': '<workbook><sheets><sheet name="Order Details" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': sst,
    'xl/worksheets/sheet1.xml': sheet,
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = zlib.deflateRawSync(Buffer.from(text));
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const HEAD = ['Retailer ID', 'DBA', 'Product ID', 'Product Description', 'Order Quantity', 'Separate Order Number', 'Invoice Number',
  'Invoice Date', 'Unit of Measure', 'Order Line Number', 'Line Voided?', 'Pricing Origin', 'UPC', 'Order Origin', 'Day', 'Load #',
  'Stop Number', 'Picked?', 'Type of Order Line'];
// Made-up stores and invoices in VIP's layout.
const row = (o) => HEAD.map((h) => o[h] ?? '');
const base = { 'Invoice Date': '20261103', 'Line Voided?': 'N', 'Pricing Origin': 'Invoice Pricing', 'Order Origin': 'iOS/PDA (PALMEDIT)',
  Day: 'Tuesday', 'Picked?': '1', 'Type of Order Line': 2, 'Separate Order Number': 1 };
const ROWS = [HEAD,
  // Store A, load 201 stop 8: beer invoice + wine invoice, a delivery message over two lines, a tax line and a return.
  row({ ...base, 'Retailer ID': '01001', DBA: 'TEST MART #1', 'Product ID': '00997', 'Product Description': 'Trade 2 bud light 30s', 'Order Quantity': 0, 'Invoice Number': 900001, 'Unit of Measure': 'Invoice Message', 'Order Line Number': 9, 'Load #': '201', 'Stop Number': 0, 'Type of Order Line': 6, 'Picked?': '0', UPC: '18200530302' }),
  row({ ...base, 'Retailer ID': '01001', DBA: 'TEST MART #1', 'Product ID': '00997', 'Product Description': 'take to back cooler', 'Order Quantity': 0, 'Invoice Number': 900001, 'Unit of Measure': 'Invoice Message', 'Order Line Number': 10, 'Load #': '201', 'Stop Number': 0, 'Type of Order Line': 6, 'Picked?': '0' }),
  row({ ...base, 'Retailer ID': '01001', DBA: 'TEST MART #1', 'Product ID': '00735', 'Product Description': 'BUD LT 30/12 CAN', 'Order Quantity': 6, 'Invoice Number': 900001, 'Unit of Measure': 'Case Beer', 'Order Line Number': 1, 'Load #': '201', 'Stop Number': 8, UPC: '18200530302' }),
  row({ ...base, 'Retailer ID': '01001', DBA: 'TEST MART #1', 'Product ID': '00439', 'Product Description': 'MULTRA 24/12 CAN', 'Order Quantity': 2, 'Invoice Number': 900001, 'Unit of Measure': 'Case Beer', 'Order Line Number': 2, 'Load #': '201', 'Stop Number': 8, UPC: '018200007118' }),
  row({ ...base, 'Retailer ID': '01001', DBA: 'TEST MART #1', 'Product ID': '50001', 'Product Description': '12/750 TEST RED', 'Order Quantity': 1, 'Invoice Number': 900002, 'Unit of Measure': 'Case Wine', 'Order Line Number': 1, 'Load #': '201', 'Stop Number': 8 }),
  row({ ...base, 'Retailer ID': '01001', DBA: 'TEST MART #1', 'Product ID': '99901', 'Product Description': 'MISC SER CHG', 'Order Quantity': 1, 'Invoice Number': 900001, 'Unit of Measure': 'Miscellaneous', 'Order Origin': 'Tax', 'Load #': '201', 'Stop Number': 8 }),
  row({ ...base, 'Retailer ID': '01001', DBA: 'TEST MART #1', 'Product ID': '00547', 'Product Description': 'NAT LT DAD 16OZ 4/6', 'Order Quantity': -1, 'Invoice Number': 900001, 'Unit of Measure': 'Case Beer', 'Load #': '201', 'Stop Number': 8, 'Picked?': '0' }),
  // A stock-out: regular invoice line VIP didn't pick.
  row({ ...base, 'Retailer ID': '01001', DBA: 'TEST MART #1', 'Product ID': '01172', 'Product Description': 'NEW BELGIUM VDR JF IPA 4/6', 'Order Quantity': 1, 'Invoice Number': 900001, 'Unit of Measure': 'Case Beer', 'Load #': '201', 'Stop Number': 8, 'Picked?': '0' }),
  // The same item again without *OUT: it still needs to be picked.
  row({ ...base, 'Retailer ID': '01001', DBA: 'TEST MART #1', 'Product ID': '01172', 'Product Description': 'NEW BELGIUM VDR JF IPA 4/6', 'Order Quantity': 2, 'Invoice Number': 900002, 'Unit of Measure': 'Case Beer', 'Load #': '201', 'Stop Number': 8 }),
  // A pricing correction (not picked, misc charges) and a voided line: both left out.
  row({ ...base, 'Retailer ID': '01001', DBA: 'TEST MART #1', 'Product ID': '00735', 'Product Description': 'BUD LT 30/12 CAN', 'Order Quantity': 1, 'Invoice Number': 900003, 'Unit of Measure': 'Case Beer', 'Pricing Origin': 'Misc. Charges', 'Load #': '201', 'Stop Number': 8, 'Picked?': '0' }),
  row({ ...base, 'Retailer ID': '01001', DBA: 'TEST MART #1', 'Product ID': '00125', 'Product Description': 'BUD LN 4/6', 'Order Quantity': 3, 'Invoice Number': 900001, 'Unit of Measure': 'Case Beer', 'Line Voided?': 'Y', 'Load #': '201', 'Stop Number': 8 }),
  // Store B: a keg on truck 6.
  row({ ...base, 'Retailer ID': '02002', DBA: 'TEST TAVERN', 'Product ID': '00800', 'Product Description': 'BUD LT 1/4 BBL', 'Order Quantity': 2, 'Invoice Number': 900010, 'Unit of Measure': 'Quarter Keg', 'Load #': '206', 'Stop Number': 3 }),
  // Monday (load 104) and another warehouse (load 214).
  row({ ...base, 'Retailer ID': '03003', DBA: 'MONDAY STORE', 'Product ID': '00735', 'Product Description': 'BUD LT 30/12 CAN', 'Order Quantity': 4, 'Invoice Number': 900020, 'Invoice Date': '20261102', Day: 'Monday', 'Unit of Measure': 'Case Beer', 'Load #': '104', 'Stop Number': 2 }),
  row({ ...base, 'Retailer ID': '04004', DBA: 'OTHER WAREHOUSE', 'Product ID': '00735', 'Product Description': 'BUD LT 30/12 CAN', 'Order Quantity': 9, 'Invoice Number': 900030, 'Unit of Measure': 'Case Beer', 'Load #': '214', 'Stop Number': 1 }),
];

test('reads the spreadsheet cells', () => {
  const rows = readXlsx(makeXlsx(ROWS));
  assert.equal(rows.length, ROWS.length);
  assert.deepEqual(rows[0], HEAD);
  assert.equal(rows[3][1], 'TEST MART #1');
  assert.equal(rows[3][4], 6);
});

test('turns the VIP order record into pick orders for our warehouse', () => {
  const r = parseImport(makeXlsx(ROWS), 'orderrecord.xlsx');
  assert.equal(r.format, 'VIP order record');
  assert.deepEqual(r.skipped, { otherWarehouses: 1, voided: 1, returnsAndCredits: 2, tax: 1, empties: 0 });
  assert.deepEqual(r.days.map((d) => [d.day_no, d.dayName, d.date, d.loads.join(','), d.orders, d.cases]),
    [['1', 'Monday', '11/02/26', '104', 1, 4], ['2', 'Tuesday', '11/03/26', '201,206', 2, 14]]);

  const a = r.orders.find((o) => o.store === 'TEST MART #1');
  assert.equal(a.load_no, '201');
  assert.equal(a.truck, 1);
  assert.equal(a.stop, '008', 'stop comes from the product lines, not the stop-0 messages');
  assert.equal(a.account_no, '01001');
  assert.equal(a.order_date, '11/03/26');
  assert.deepEqual(a.invoices.sort(), ['900001', '900002']);
  assert.deepEqual(a.notes, ['Trade 2 bud light 30s take to back cooler']);
  assert.deepEqual(a.lines.map((l) => [l.code, l.qty, l.unit, l.vipOut, l.invoice]), [
    ['00735', 6, 'CASES', false, '900001'],
    ['00439', 2, 'CASES', false, '900001'],
    ['50001', 1, 'CASES', false, '900002'],
    ['01172', 1, 'CASES', true, '900001'],
    ['01172', 2, 'CASES', false, '900002'],
  ]);
  const keg = r.orders.find((o) => o.store === 'TEST TAVERN');
  assert.deepEqual([keg.truck, keg.lines[0].unit], [6, 'KEGS']);

  // UPCs from product lines only (the message line's UPC is ignored); leading zero restored.
  assert.deepEqual(r.barcodes.map((b) => [b.upc, b.code]).sort(), [['018200007118', '00439'], ['018200530302', '00735']]);
});

test('load numbers and UPCs', () => {
  assert.deepEqual(loadParts('201'), { day: '2', warehouse: '0', truck: 1 });
  assert.equal(loadParts('2011'), null);
  assert.equal(upcOf('18200530302'), '018200530302');
  assert.equal(upcOf('0'), null);
  assert.equal(upcOf('10088004040892'), '10088004040892');
  assert.equal(upcOf('1153972'), null);
});

test('a CSV export with the same columns works too', () => {
  const csv = ROWS.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const r = parseImport(csv, 'orderrecord.csv');
  assert.equal(r.format, 'VIP order record');
  assert.equal(r.orders.length, 3);
});

test('management uploads the file, imports one day, and re-importing is blocked', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-vipapi-'));
  process.env.ADMIN_PIN = '8642';
  const app = require('../server/app');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', pin: '8642' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const json = (m, u, b) => fetch(base + u, { method: m, headers: { 'content-type': 'application/json', cookie }, body: b && JSON.stringify(b) }).then((r) => r.json());

  const res = await fetch(`${base}/orders/import/preview`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': 'orderrecord.xlsx', cookie }, body: makeXlsx(ROWS),
  });
  const preview = await res.json();
  assert.equal(res.status, 200, JSON.stringify(preview));
  assert.equal(preview.days.length, 2);
  assert.deepEqual(preview.barcodes.new, 2);
  const tuesday = preview.orders.filter((o) => o.day_no === '2');
  assert.deepEqual(tuesday.map((o) => o.truck).sort(), [1, 6]);

  const done = await json('POST', '/orders/import', { orders: tuesday, barcodes: preview.barcodes.list });
  assert.deepEqual([done.created, done.skipped.length, done.barcodesAdded], [2, 0, 2]);
  const again = await json('POST', '/orders/import', { orders: tuesday, barcodes: preview.barcodes.list });
  assert.deepEqual([again.created, again.skipped[0].error, again.barcodesAdded], [0, 'Already imported', 0]);
  const second = await (await fetch(`${base}/orders/import/preview`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': 'orderrecord.xlsx', cookie }, body: makeXlsx(ROWS),
  })).json();
  assert.ok(second.orders.filter((o) => o.day_no === '2').every((o) => o.duplicateOf), 'already-imported orders are flagged in the preview');

  const truck1 = await json('GET', '/orders?truck=1&active=1');
  assert.equal(truck1[0].store, 'TEST MART #1');
  const order = await json('GET', `/orders/${truck1[0].id}`);
  assert.deepEqual(order.notes.map((n) => [n.text, n.user_id]), [['Trade 2 bud light 30s take to back cooler', null]]);
  assert.deepEqual(order.lines.filter((l) => l.code === '01172').map((l) => [l.qty, l.out_reason]), [[1, 'vip'], [2, null]]);
  assert.equal(order.lines.find((l) => l.code === '50001').invoice_no, '900002');
  const scan = await json('GET', '/barcodes/lookup?raw=18200530302');
  assert.equal(scan.item.code, '00735', 'scanning the case finds the item from the VIP UPC');
  const trucks = await json('GET', '/trucks');
  assert.deepEqual(trucks.trucks.find((x) => x.truck === 6).loads, ['206']);

  // A test run of Monday's orders: marked TEST, doesn't block the real import, deleted in one go.
  const monday = preview.orders.filter((o) => o.day_no === '1');
  const test1 = await json('POST', '/orders/import', { orders: monday, testRun: true });
  assert.equal(test1.created, 1);
  const testOrders = (await json('GET', '/orders')).filter((o) => o.is_test);
  assert.deepEqual(testOrders.map((o) => o.store), ['MONDAY STORE']);
  const real = await json('POST', '/orders/import', { orders: monday });
  assert.equal(real.created, 1, 'the real import still goes in after a test run');
  const cleared = await json('DELETE', '/admin/test-orders');
  assert.equal(cleared.removed, 1);
  const left = await json('GET', '/orders');
  assert.equal(left.filter((o) => o.store === 'MONDAY STORE').length, 1);
  assert.ok(left.every((o) => !o.is_test));
});

test('kegs are only kept for trucks due on keg days (Tuesday and Wednesday by default)', () => {
  const { applyKegRule, deliveryWeekday } = require('../server/vip');
  const parsed = parseImport(makeXlsx(ROWS), 'orderrecord.xlsx');
  assert.equal(deliveryWeekday({ order_date: '11/03/26' }), 2);
  assert.equal(deliveryWeekday({ order_date: '', day_no: '3' }), 3);
  const tueWed = applyKegRule(parsed, [2, 3]);
  assert.ok(tueWed.orders.some((o) => o.store === 'TEST TAVERN'), 'Tuesday keg stays');
  assert.equal(tueWed.skipped.kegs, 0);
  const wedOnly = applyKegRule(parsed, [3]);
  assert.ok(!wedOnly.orders.some((o) => o.store === 'TEST TAVERN'), 'a Tuesday order with only kegs drops out');
  assert.equal(wedOnly.skipped.kegs, 1);
  assert.match(wedOnly.warnings.at(-1), /only kegs/);
  assert.equal(wedOnly.days.find((d) => d.day_no === '2').cases, 12);
});
