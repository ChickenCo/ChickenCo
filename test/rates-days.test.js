// Pick rates (cases per hour of active picking) and work days (end when every truck is done).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-rates-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ADMIN_PIN = '1470';
const app = require('../server/app');
const { run } = require('../server/db');
const { hashPin } = require('../server/auth');
const rates = require('../server/rates');

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

async function signIn(username, pin) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  assert.equal((await call('POST', '/login', { username, pin })).status, 200);
  const ok = async (m, u, b) => { const r = await call(m, u, b); assert.ok(r.status < 300, `${m} ${u} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
  return { call, get: (u) => ok('GET', u), post: (u, b = {}) => ok('POST', u, b), put: (u, b = {}) => ok('PUT', u, b) };
}

test('pick rate counts active time only, caps breaks at 10 minutes, and skips test orders', () => {
  const pickerId = Number(run("INSERT INTO users (username, name, pin_hash, role, created_at) VALUES ('ratepicker', 'Rate Picker', ?, 'picker', 0)", hashPin('1111')).lastInsertRowid);
  const dayId = Number(run('INSERT INTO days (started_at, ended_at) VALUES (0, 1)').lastInsertRowid);
  const min = 60000;
  const t0 = 1_000_000_000_000;
  const order = (isTest) => Number(run("INSERT INTO orders (day_id, is_test, load_no, store, status, created_at) VALUES (?, ?, '201', 'X', 'done', 0)", dayId, isTest).lastInsertRowid);
  const ev = (orderId, type, at, detail) => run('INSERT INTO events (order_id, user_id, type, detail, at) VALUES (?, ?, ?, ?, ?)',
    orderId, pickerId, type, detail ? JSON.stringify(detail) : null, at);

  const real = order(0);
  ev(real, 'started', t0);
  ev(real, 'picked', t0 + 5 * min, { from: 0, to: 30 });
  ev(real, 'picked', t0 + 10 * min, { from: 0, to: 30 });
  ev(real, 'picked', t0 + 50 * min, { from: 0, to: 20 }); // 40-minute break: counts as 10
  ev(real, 'out', t0 + 51 * min, { qty: 1 });
  ev(real, 'submitted', t0 + 52 * min);
  run("INSERT INTO events (order_id, user_id, type, detail, at) VALUES (?, 1, 'found', ?, ?)", real, JSON.stringify({ outBy: pickerId, reason: 'cant_find' }), t0 + 60 * min);

  const practice = order(1);
  ev(practice, 'started', t0);
  ev(practice, 'picked', t0 + 1 * min, { from: 0, to: 500 });
  ev(practice, 'completed', t0 + 2 * min);

  const [row] = rates.compute({ dayId, now: t0 + 120 * min });
  assert.equal(row.name, 'Rate Picker');
  assert.equal(row.cases, 80);
  assert.equal(row.activeMs, 22 * min); // 5 + 5 + 10 (capped) + 1 + 1
  assert.equal(row.rate, Math.round(80 / (22 / 60))); // 218 cases/hour
  assert.equal(row.outs, 1);
  assert.equal(row.foundOnShelf, 1);

  const withTests = rates.compute({ dayId, includeTests: true, now: t0 + 120 * min });
  assert.equal(withTests[0].cases, 580);
});

test('the day ends when every truck is done, with totals, top sellers and most out', async () => {
  const admin = await signIn('admin', '1470');
  await admin.post('/users', { name: 'Day Picker', username: 'daypicker', role: 'picker', pin: '2222' });
  await admin.post('/users', { name: 'Day Boss', username: 'dayboss', role: 'supervisor', pin: '3333' });
  const picker = await signIn('daypicker', '2222');
  const boss = await signIn('dayboss', '3333');

  const a = await admin.post('/orders', { truck: 1, stop: '001', store: 'A MART', lines: [
    { code: '00735', description: 'BUD LT 30/12 CAN', qty: 10 }, { code: '00439', description: 'MULTRA 24/12 CAN', qty: 4 }] });
  const b = await admin.post('/orders', { truck: 2, stop: '004', store: 'B MART', lines: [
    { code: '00735', qty: 6 }, { code: '00125', description: 'BUD LN 4/6', qty: 3 }] });
  assert.equal(a.day_id, b.day_id, 'both orders are on the same work day');

  let home = await picker.get('/trucks');
  assert.equal(home.day.totals.cases, 23);
  assert.equal(home.day.totals.left, 23);
  assert.equal(home.day.ended_at, null);
  assert.equal(home.day.top, null, 'top sellers wait until the trucks are done');

  // Order A: everything picked.
  let o = await picker.post(`/orders/${a.id}/start`);
  for (const l of o.lines) o = await picker.post(`/orders/${a.id}/lines/${l.id}/pick`, { picked: l.qty });
  await picker.post(`/orders/${a.id}/submit`);
  home = await picker.get('/trucks');
  assert.equal(home.day.ended_at, null, 'truck 2 still has an order');

  // Order B: BUD LN short 2, supervisor confirms and approves -> day ends.
  o = await picker.post(`/orders/${b.id}/start`);
  const ln = o.lines.find((l) => l.code === '00125');
  o = await picker.post(`/orders/${b.id}/lines/${o.lines.find((l) => l.code === '00735').id}/pick`, { picked: 6 });
  o = await picker.post(`/orders/${b.id}/lines/${ln.id}/pick`, { picked: 1 });
  o = await picker.post(`/orders/${b.id}/lines/${ln.id}/out`, { qty: 2, reason: 'out_of_stock' });
  await picker.post(`/orders/${b.id}/submit`);
  await boss.post(`/orders/${b.id}/lines/${ln.id}/confirm-out`);
  await boss.post(`/orders/${b.id}/approve`);

  home = await picker.get('/trucks');
  assert.ok(home.day.ended_at, 'all trucks loaded ends the day');
  assert.deepEqual(home.day.totals, { orders: 2, orders_done: 2, cases: 23, picked: 21, outs: 2, left: 0 });
  assert.deepEqual(home.day.top.map((t) => [t.code, t.cases]), [['00735', 16], ['00439', 4], ['00125', 1]]);
  assert.deepEqual(home.day.mostOut.map((t) => [t.code, t.cases]), [['00125', 2]]);

  // Pick rates: the picker only sees their own row, the supervisor sees everyone.
  const mine = await picker.get('/rates');
  assert.deepEqual(mine.rows.map((r) => r.name), ['Day Picker']);
  assert.equal(mine.rows[0].cases, 21);
  assert.equal(mine.target, 100);
  const all = await boss.get('/rates?period=week');
  assert.ok(all.rows.some((r) => r.name === 'Day Picker'));
  assert.equal((await picker.call('PUT', '/settings/pick-rate', { min: 50 })).status, 403);
  assert.equal((await boss.put('/settings/pick-rate', { min: 120 })).target, 120);

  // The next order starts a new day.
  const c = await admin.post('/orders', { truck: 3, stop: '002', store: 'C MART', lines: [{ code: '00735', qty: 2 }] });
  assert.notEqual(c.day_id, a.day_id);
  home = await picker.get('/trucks');
  assert.equal(home.day.id, c.day_id);
  assert.equal(home.day.totals.cases, 2);

  const history = await admin.get('/days');
  assert.equal(history.find((d) => d.id === a.day_id).topSeller.code, '00735');
});
