// VIP import: the IN005 pick list layout (from the printed Chuck's Carry Out sheet) and CSV.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVipText, parseCsv, parseImport } = require('../server/vip');

const SHEET = [
  'Copyright 2008 Vermont Information Processing, Inc.   WHSE # 1 DAY# 2 LOAD#201',
  '                        -IN005- PICK LIST - - - - - -       **NEW** 15:37:56 10/12/26',
  'PERRY DISTRIBUTING  - - - - - - - - - - - LONDON  - - - - - - KY STOP 008  ZONE 01',
  'TRUCK #:',
  '1237 CHUCK\'\'S CARRY OUT   - - - - 79 WACO DR',
  'SLOT# CASES  BTLS KEGS  MISC     CODE  PRODUCT DESCRIPTION',
  '        1                        00014  STELLA LN 2/12',
  '       18                        00439  MULTRA 24/12 CAN',
  '                3                00547  NAT LT DAD 16OZ 4/6',
  '        1  *OUT                   01172  NEW BELGIUM VDR JF IPA 4/6',
].join('\n');

test('reads the IN005 pick list header and lines', () => {
  const { orders, warnings } = parseVipText(SHEET);
  assert.deepEqual(warnings, []);
  assert.equal(orders.length, 1);
  const o = orders[0];
  assert.equal(o.load_no, '201');
  assert.equal(o.day_no, '2');
  assert.equal(o.order_date, '10/12/26');
  assert.equal(o.stop, '008');
  assert.equal(o.zone, '01');
  assert.equal(o.state, 'KY');
  assert.equal(o.city, 'LONDON');
  assert.equal(o.store, "CHUCK'S CARRY OUT");
  assert.equal(o.account_no, '1237');
  assert.equal(o.address, '79 WACO DR');
  assert.deepEqual(o.lines.map((l) => [l.code, l.qty, l.unit, l.vipOut]), [
    ['00014', 1, 'CASES', false],
    ['00439', 18, 'CASES', false],
    ['00547', 3, 'BTLS', false],
    ['01172', 1, 'CASES', true],
  ]);
});

test('splits a file with several pick lists into orders', () => {
  const second = SHEET.replace('LOAD#201', 'LOAD#202').replace('STOP 008', 'STOP 003').replace("CHUCK''S CARRY OUT", 'LAKESIDE PACKAGE');
  const { orders } = parseVipText(`${SHEET}\n\f${second}`);
  assert.deepEqual(orders.map((o) => [o.load_no, o.stop, o.store]), [['201', '008', "CHUCK'S CARRY OUT"], ['202', '003', 'LAKESIDE PACKAGE']]);
  const noFormFeed = parseVipText(`${SHEET}\n${second}`).orders;
  assert.equal(noFormFeed.length, 2);
  assert.equal(noFormFeed[1].lines.length, 4);
});

test('reads a CSV export and groups rows into orders', () => {
  const csv = 'Load,Stop,Store,City,Code,Description,Qty,Unit,Out\n201,008,"CHUCK\'S CARRY OUT",LONDON,00014,STELLA LN 2/12,1,CASES,\n201,008,"CHUCK\'S CARRY OUT",LONDON,01172,NEW BELGIUM VDR JF IPA 4/6,1,,Y\n202,003,LAKESIDE PACKAGE,CORBIN,00720,BUD LT 12/12 CAN,6,,\n';
  const { orders, warnings } = parseCsv(csv);
  assert.deepEqual(warnings, []);
  assert.equal(orders.length, 2);
  assert.deepEqual(orders[0].lines.map((l) => [l.code, l.vipOut]), [['00014', false], ['01172', true]]);
  assert.equal(parseImport(csv, 'orders.csv').orders.length, 2);
  assert.match(parseCsv('Stop,Code\n1,2\n').warnings[0], /load/);
});
