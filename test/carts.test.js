// VIP stops are renumbered in loading order, and small orders share carts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-carts-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ADMIN_PIN = '1470';
const app = require('../server/app');
const vip = require('../server/vip');

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

const order = (load, stop, store, cases, extra = {}) => ({ load_no: load, stop, store, lines: [{ code: '00735', description: 'BUD LT 30/12 CAN', qty: cases }], ...extra });

test('pallet stops are reversed and small orders are packed onto shared carts', () => {
  const orders = [
    order('201', '001', 'KROGER', 15),
    order('201', '002', 'WALMART', 15),
    order('201', '003', 'BIG STORE', 90),
    order('201', '004', 'MEDIUM', 36),
    order('201', '005', 'GAS', 30),
    order('201', '006', 'HUGE', 120, { lines: [{ code: 'A', qty: 120 }, { code: 'B', qty: 5, vipOut: true }] }),
    order('202', '001', 'OTHER TRUCK', 10),
  ];
  vip.arrangeLoads(orders, { cartMax: 35 });
  const by = Object.fromEntries(orders.map((o) => [o.store, o]));
  // Pallets: VIP stops 6, 4, 3 become 001, 002, 003.
  assert.deepEqual(['HUGE', 'MEDIUM', 'BIG STORE'].map((s) => [by[s].stop, by[s].is_cart]), [['001', false], ['002', false], ['003', false]]);
  assert.equal(by.MEDIUM.vip_stop, '004');
  // 36 cases is over the limit; 30 + 15 > 35, so GAS rides alone and Kroger + Walmart share.
  assert.equal(by.KROGER.is_cart, true);
  assert.equal(by.KROGER.cart_no, by.WALMART.cart_no);
  assert.notEqual(by.GAS.cart_no, by.KROGER.cart_no);
  assert.equal(by.GAS.cart_no, 1, 'the cart with the last delivery is Cart 1');
  assert.equal(by.KROGER.stop, '');
  assert.equal(by['OTHER TRUCK'].cart_no, 1, 'carts are numbered per truck');

  const none = vip.arrangeLoads([order('201', '001', 'A', 5), order('201', '002', 'B', 50)], { cartMax: 0 });
  assert.deepEqual(none.map((o) => [o.store, o.stop, o.is_cart]), [['A', '002', false], ['B', '001', false]]);
});

test('a truck can be re-arranged after import, and the cart size is a setting', async () => {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    assert.ok(res.status < 300, `${method} ${url} -> ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  await call('POST', '/login', { username: 'admin', pin: '1470' });
  const vipRef = (s) => `201:${s}:2026-11-09`;
  // Imported as-is (the way orders came in before this change).
  await call('POST', '/orders/import', { orders: [
    order('201', '001', 'KROGER', 15, { vip_ref: vipRef(1) }), order('201', '002', 'WALMART', 15, { vip_ref: vipRef(2) }),
    order('201', '003', 'BIG STORE', 90, { vip_ref: vipRef(3) }), order('201', '004', 'MEDIUM', 60, { vip_ref: vipRef(4) })] });
  await call('POST', '/orders', order('201', '009', 'TYPED IN', 5));
  assert.equal((await call('PUT', '/settings/carts', { max: 35 })).cartMax, 35);
  const r = await call('POST', '/trucks/1/arrange');
  assert.deepEqual(r, { orders: 4, moved: 4, carts: 1 });
  const list = await call('GET', '/orders?truck=1');
  const label = (s) => { const o = list.find((x) => x.store === s); return o.is_cart ? `Cart ${o.cart_no}` : `Stop ${o.stop}`; };
  assert.deepEqual(['MEDIUM', 'BIG STORE', 'KROGER', 'WALMART', 'TYPED IN'].map(label), ['Stop 001', 'Stop 002', 'Cart 1', 'Cart 1', 'Stop 009']);
  // Running it again changes nothing.
  assert.equal((await call('POST', '/trucks/1/arrange')).moved, 0);
  // A supervisor can move an order to another cart by hand.
  const walmart = list.find((x) => x.store === 'WALMART');
  const moved = await call('PUT', `/orders/${walmart.id}/stop`, { cart: true, cartNo: 2 });
  assert.equal(moved.cart_no, 2);
});
