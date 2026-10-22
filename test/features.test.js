// Drivers and notes, next order, repeat-out alerts, floor view, PIN requests, VIP import, offline scan times.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-features-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ADMIN_PIN = '7531';
const app = require('../server/app');
const { one } = require('../server/db');

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

async function call(method, url, body, cookie = '') {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
async function signIn(username, pin) {
  const r = await call('POST', '/login', { username, pin });
  assert.equal(r.status, 200, `${username} sign in`);
  const ok = async (m, u, b) => { const x = await call(m, u, b, r.cookie); assert.ok(x.status < 300, `${m} ${u} -> ${x.status} ${JSON.stringify(x.data)}`); return x.data; };
  return { call: (m, u, b) => call(m, u, b, r.cookie), get: (u) => ok('GET', u), post: (u, b = {}) => ok('POST', u, b), del: (u) => ok('DELETE', u) };
}

let admin, picker, picker2, driver, boss;
const order = (truck, stop, store, lines) => admin.post('/orders', { truck, stop, store, lines });

test('setup', async () => {
  admin = await signIn('admin', '7531');
  for (const [name, username, role, pin] of [['Pat Pick', 'ppick', 'picker', '1111'], ['Sky Pick', 'spick', 'picker', '1212'],
    ['Dee Driver', 'ddrive', 'driver', '2222'], ['Bo Boss', 'bboss', 'supervisor', '3333']]) {
    await admin.post('/users', { name, username, role, pin });
  }
  picker = await signIn('ppick', '1111');
  picker2 = await signIn('spick', '1212');
  driver = await signIn('ddrive', '2222');
  boss = await signIn('bboss', '3333');
});

test('drivers can read orders and leave notes but not pick', async () => {
  const o = await order(1, '002', 'MAIN ST MARKET', [{ code: '00735', description: 'BUD LT 30/12 CAN', qty: 4 }]);
  assert.equal((await driver.call('POST', `/orders/${o.id}/start`)).status, 403);
  assert.equal((await driver.call('POST', '/trucks/1/next')).status, 403);
  assert.equal((await driver.call('GET', `/orders/${o.id}`)).status, 200);
  await driver.post('/notes', { scope: 'truck', truck: 1, text: 'Kegs on the left side, stop 2 goes on last' });
  await driver.post('/notes', { scope: 'truck', truck: 1, everyDay: true, text: 'Liftgate is slow, load heavy cases first' });
  await admin.post('/notes', { scope: 'store', orderId: o.id, text: 'Back door delivery' });
  await boss.post('/notes', { scope: 'order', orderId: o.id, text: 'Keep the Bud Light together' });
  assert.equal((await picker.call('POST', '/notes', { scope: 'order', orderId: o.id, text: 'hi' })).status, 403, 'pickers only read notes');

  const seen = await picker.get(`/orders/${o.id}`);
  assert.deepEqual(seen.notes.map((n) => [n.scope, n.text]), [
    ['order', 'Keep the Bud Light together'],
    ['store', 'Back door delivery'],
    ['truck', 'Kegs on the left side, stop 2 goes on last'],
    ['truck', 'Liftgate is slow, load heavy cases first'],
  ]);
  // A store note follows the store to its next order.
  const again = await order(2, '005', 'MAIN ST MARKET', [{ code: '00735', qty: 1 }]);
  assert.ok((await picker.get(`/orders/${again.id}`)).notes.some((n) => n.text === 'Back door delivery'));
  const truckNotes = await picker.get('/trucks/1/notes');
  assert.equal(truckNotes.length, 2);
  const driverNote = truckNotes[0];
  assert.equal((await picker.call('DELETE', `/notes/${driverNote.id}`)).status, 403);
  await driver.del(`/notes/${driverNote.id}`);
  assert.equal((await picker.get('/trucks/1/notes')).length, 1);
  // Drivers aren't offered when assigning orders.
  assert.ok(!(await boss.get('/employees')).some((e) => e.username === 'ddrive'));
});

test('next order takes the lowest unstarted stop on the truck', async () => {
  await order(3, '009', 'NINE', [{ code: '00735', qty: 1 }]);
  await order(3, '004', 'FOUR', [{ code: '00735', qty: 1 }]);
  const first = await picker.post('/trucks/3/next');
  assert.equal(first.store, 'FOUR');
  assert.equal(first.picker_name, 'Pat Pick');
  const second = await picker2.post('/trucks/3/next');
  assert.equal(second.store, 'NINE');
  assert.equal((await picker.call('POST', '/trucks/3/next')).status, 404);
});

test('scans saved offline keep the time they happened', async () => {
  const o = await order(4, '001', 'OFFLINE MART', [{ code: '00735', qty: 3 }]);
  await picker.post(`/orders/${o.id}/start`);
  const tenMinAgo = Date.now() - 10 * 60000;
  await picker.post(`/orders/${o.id}/lines/${o.lines[0].id}/pick`, { picked: 2, at: tenMinAgo });
  assert.equal(one("SELECT at FROM events WHERE order_id = ? AND type = 'picked'", o.id).at, tenMinAgo);
  await picker.post(`/orders/${o.id}/lines/${o.lines[0].id}/pick`, { picked: 3, at: Date.now() + 86400000 });
  assert.ok(one("SELECT MAX(at) at FROM events WHERE order_id = ? AND type = 'picked'", o.id).at <= Date.now(), 'future times are not trusted');
  const codes = await picker.get(`/orders/${o.id}/barcodes`);
  assert.ok(Array.isArray(codes));
});

test('the same item out on 3 orders raises one alert and shows on the floor view', async () => {
  for (const [stop, who] of [['011', picker], ['012', picker2], ['013', picker]]) {
    const o = await order(5, stop, `STORE ${stop}`, [{ code: '00439', description: 'MULTRA 24/12 CAN', qty: 2 }]);
    await who.post(`/orders/${o.id}/start`);
    await who.post(`/orders/${o.id}/lines/${o.lines[0].id}/out`, { qty: 2, reason: 'out_of_stock' });
    if (stop !== '013') await who.post(`/orders/${o.id}/submit`);
  }
  const floor = await boss.get('/floor');
  assert.deepEqual(floor.repeatOuts.map((r) => [r.code, r.orders]), [['00439', 3]]);
  const pat = floor.people.find((p) => p.name === 'Pat Pick');
  assert.equal(pat.order.store, 'STORE 013', 'shows what each picker is on right now');
  assert.ok(pat.lastAt);
  assert.ok(floor.trucks.find((t) => t.truck === 5).review >= 2);
  assert.equal((await picker.call('GET', '/floor')).status, 403);

  const trends = await admin.get('/reports/out-trends');
  const multra = trends.find((t) => t.code === '00439');
  assert.equal(multra.cases, 6);
  assert.equal(multra.stores, 3);
});

test('forgot PIN goes to the admin and clears when a new PIN is set', async () => {
  const known = await call('POST', '/pin-request', { username: 'spick' });
  const unknown = await call('POST', '/pin-request', { username: 'nobody' });
  assert.deepEqual(known.data, unknown.data, 'same answer either way');
  await call('POST', '/pin-request', { username: 'spick' }); // no duplicate
  let list = await admin.get('/pin-requests');
  assert.deepEqual(list.map((r) => r.username), ['spick']);
  assert.equal((await admin.get('/ping')).pinRequests, 1);
  const sky = list[0];
  const users = await admin.get('/users');
  await admin.call('PUT', `/users/${users.find((u) => u.username === 'spick').id}`, { pin: '4545' });
  list = await admin.get('/pin-requests');
  assert.equal(list.length, 0);
  await signIn('spick', '4545');
  assert.ok(sky.created_at);
});

test('VIP import previews first, flags duplicates and new items, then creates orders', async () => {
  const text = [
    'Copyright 2008 Vermont Information Processing, Inc.   WHSE # 1 DAY# 3 LOAD#206',
    '                        -IN005- PICK LIST          **NEW** 06:02:11 10/13/26',
    'PERRY DISTRIBUTING  - - - - - - - - LONDON - - - - KY STOP 002  ZONE 01',
    '4410 HILLTOP GROCERY  - - - - 9 RIDGE PIKE',
    'SLOT# CASES  BTLS KEGS  MISC     CODE  PRODUCT DESCRIPTION',
    '        4                        00735  BUD LT 30/12 CAN',
    '        2                        09999  BRAND NEW SELTZER 12PK',
  ].join('\n');
  const preview = await admin.post('/orders/import/preview', { text, filename: 'in005.txt' });
  assert.deepEqual(preview.warnings, []);
  const [p] = preview.orders;
  assert.equal(p.truck, 6);
  assert.equal(p.store, 'HILLTOP GROCERY');
  assert.equal(p.cases, 6);
  assert.deepEqual(p.newItems, ['09999']);
  assert.equal(p.duplicateOf, null);
  const done = await admin.post('/orders/import', { orders: preview.orders });
  assert.equal(done.created, 1);
  const again = await admin.post('/orders/import/preview', { text, filename: 'in005.txt' });
  assert.ok(again.orders[0].duplicateOf, 'importing the same file twice is flagged');
  assert.equal((await picker.call('POST', '/orders/import/preview', { text })).status, 403);
  const truck6 = await picker.get('/orders?truck=6&active=1');
  assert.equal(truck6[0].store, 'HILLTOP GROCERY');
});
