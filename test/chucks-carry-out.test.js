// Test run of the real Chuck's Carry Out pick list (Truck 1 / Load 201 / Stop 008),
// played through the API the same way the phones use it: picker scans every case,
// marks one item out, a supervisor checks the outs and approves, management reads the reports.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ADMIN_PIN = '9876';
const app = require('../server/app');
const { demoUpc, ITEMS, CHUCKS_QTY } = require('../server/demo');

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

// A signed-in phone: keeps its own session cookie.
async function signIn(username, pin) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  const login = await call('POST', '/login', { username, pin });
  assert.equal(login.status, 200, `${username} should sign in`);
  const ok = async (method, url, body) => {
    const r = await call(method, url, body);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  return { call, get: (u) => ok('GET', u), post: (u, b = {}) => ok('POST', u, b) };
}

const SHEET = ITEMS.map(([code, description], i) => ({ code, description, qty: CHUCKS_QTY[i] }));

test("Chuck's Carry Out test run", async (t) => {
  const admin = await signIn('admin', '9876');
  let order;

  await t.test('admin adds the test run and it lands on Truck 1', async () => {
    await admin.post('/admin/demo'); // test logins + item barcodes
    const { id } = await admin.post('/admin/test-run');
    order = await admin.get(`/orders/${id}`);
    assert.equal(order.truck, 1);
    assert.equal(order.load_no, '201');
    assert.equal(order.stop, '008');
    assert.match(order.store, /^CHUCK'S CARRY OUT/);
    assert.equal(order.address, '79 WACO DR');
    assert.equal(order.lines.length, 24);
    assert.equal(order.units, 113);
    assert.deepEqual(order.lines.map((l) => [l.code, l.qty]), SHEET.map((s) => [s.code, s.qty]));

    const trucks = await admin.get('/trucks');
    assert.ok(trucks.trucks.find((tr) => tr.truck === 1).orders >= 1);
  });

  await t.test('01172 arrives already marked out, as printed on the VIP sheet', () => {
    const ipa = order.lines.find((l) => l.code === '01172');
    assert.equal(ipa.out_qty, 1);
    assert.equal(ipa.out_reason, 'vip');
  });

  const picker = await signIn('picker', '1111');
  const supervisor = await signIn('supervisor', '2222');
  const manager = await signIn('manager', '3333');

  await t.test('picker must start the order before picking, and then owns it', async () => {
    const line = order.lines[0];
    const early = await picker.call('POST', `/orders/${order.id}/lines/${line.id}/pick`, { picked: 1 });
    assert.equal(early.status, 409);
    order = await picker.post(`/orders/${order.id}/start`);
    assert.equal(order.status, 'picking');
    assert.equal(order.picker_name, 'Demo Picker');
    const other = await manager.call('POST', `/orders/${order.id}/start`);
    assert.equal(other.status, 409, 'a second person cannot grab an order being picked');
  });

  await t.test('picker scans every case barcode on the sheet', async () => {
    for (const s of SHEET) {
      if (s.code === '00235' || s.code === '01172') continue; // short below / VIP out
      const scan = await picker.get(`/barcodes/lookup?raw=${demoUpc(s.code)}&format=UPCA`);
      assert.equal(scan.item.code, s.code, `barcode for ${s.code}`);
      const line = order.lines.find((l) => l.code === scan.item.code);
      order = await picker.post(`/orders/${order.id}/lines/${line.id}/pick`, { picked: line.qty, via: 'scan' });
    }
    assert.equal(order.units_picked, 113 - 2 - 1);
  });

  await t.test('picker cannot finish while a line is unresolved', async () => {
    const r = await picker.call('POST', `/orders/${order.id}/submit`);
    assert.equal(r.status, 400);
  });

  await t.test("picker marks BUD SELECT 30/12 CAN out (can't find)", async () => {
    const line = order.lines.find((l) => l.code === '00235');
    order = await picker.post(`/orders/${order.id}/lines/${line.id}/out`, { qty: 2, reason: 'cant_find' });
    order = await picker.post(`/orders/${order.id}/submit`);
    assert.equal(order.status, 'review', 'orders with outs go to a supervisor');
  });

  await t.test('only supervisors can review', async () => {
    assert.equal((await picker.call('GET', '/review')).status, 403);
    const queue = await supervisor.get('/review');
    assert.ok(queue.some((o) => o.id === order.id));
  });

  await t.test('supervisor confirms both outs and approves', async () => {
    const early = await supervisor.call('POST', `/orders/${order.id}/approve`);
    assert.equal(early.status, 400, 'cannot approve before checking every out');
    for (const l of order.lines.filter((x) => x.out_qty > 0)) {
      order = await supervisor.post(`/orders/${order.id}/lines/${l.id}/confirm-out`);
    }
    order = await supervisor.post(`/orders/${order.id}/approve`);
    assert.equal(order.status, 'done');
    assert.equal(order.approved_by_name, 'Demo Supervisor');
  });

  await t.test('management reports show the outs and the finished order', async () => {
    const outs = (await manager.get('/reports/outs')).filter((r) => r.order_id === order.id);
    assert.deepEqual(outs.map((r) => [r.code, r.out_qty, r.out_reason, r.out_status]).sort(), [
      ['00235', 2, 'cant_find', 'confirmed'],
      ['01172', 1, 'vip', 'confirmed'],
    ]);
    assert.equal(outs.find((r) => r.code === '00235').out_by_name, 'Demo Picker');
    const finished = (await manager.get('/reports/orders')).find((o) => o.id === order.id);
    assert.equal(finished.units_picked, 110);
    assert.equal(finished.units_out, 3);
    assert.equal(finished.picker_name, 'Demo Picker');
    assert.equal((await picker.call('GET', '/reports/outs')).status, 403);
  });
});
