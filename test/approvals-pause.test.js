// Picks need a scan (or a supervisor); pausing with a reason; total pick time without pauses.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-approve-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ADMIN_PIN = '1357';
const app = require('../server/app');
const { run, one } = require('../server/db');
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

async function call(method, url, body, cookie = '') {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function signIn(username, pin) {
  const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, pin }) });
  assert.equal(res.status, 200, `${username} sign in`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const ok = async (m, u, b) => { const x = await call(m, u, b, cookie); assert.ok(x.status < 300, `${m} ${u} -> ${x.status} ${JSON.stringify(x.data)}`); return x.data; };
  return { call: (m, u, b) => call(m, u, b, cookie), get: (u) => ok('GET', u), post: (u, b = {}) => ok('POST', u, b), put: (u, b = {}) => ok('PUT', u, b) };
}

let admin, picker, boss, order;
const line = (code) => order.lines.find((l) => l.code === code);

test('setup', async () => {
  admin = await signIn('admin', '1357');
  await admin.post('/users', { name: 'Pia Picker', username: 'pia', role: 'picker', pin: '1111' });
  await admin.post('/users', { name: 'Sal Super', username: 'sal', role: 'supervisor', pin: '2222' });
  picker = await signIn('pia', '1111');
  boss = await signIn('sal', '2222');
  await admin.post('/items', { code: '00735', description: 'BUD LT 30/12 CAN' });
  await admin.post('/items', { code: '00439', description: 'MULTRA 24/12 CAN' });
  await admin.post('/barcodes', { raw: '018200530302', code: '00735' });
  await admin.post('/barcodes', { raw: '018200007118', code: '00439' });
  order = await admin.post('/orders', { truck: 1, stop: '001', store: 'SCAN MART', lines: [{ code: '00735', qty: 5 }, { code: '00439', qty: 3 }] });
  order = await picker.post(`/orders/${order.id}/start`);
});

test('a picker can add by scanning the right barcode, not by tapping or with the wrong barcode', async () => {
  const url = `/orders/${order.id}/lines/${line('00735').id}/pick`;
  let r = await picker.call('POST', url, { picked: 2, via: 'manual' });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'needs_approval');
  r = await picker.call('POST', url, { picked: 2, via: 'scan' });
  assert.equal(r.data.code, 'needs_approval', 'saying "scan" without a barcode is not a scan');
  r = await picker.call('POST', url, { picked: 2, via: 'scan', barcode: '018200007118' });
  assert.equal(r.data.code, 'needs_approval', "another item's barcode doesn't count");
  order = await picker.post(url, { picked: 2, via: 'scan', barcode: '18200530302' });
  assert.equal(line('00735').picked, 2);
  // Lowering a count is always fine, and so is undoing your own last change.
  order = await picker.post(url, { picked: 1, via: 'manual' });
  order = await picker.post(url, { picked: 2, via: 'undo' });
  assert.equal(line('00735').picked, 2);
  r = await picker.call('POST', url, { picked: 3, via: 'undo' });
  assert.equal(r.data.code, 'needs_approval', 'undo only puts back your own last change');
});

test('a supervisor can sign off on the spot with their PIN', async () => {
  const url = `/orders/${order.id}/lines/${line('00735').id}/pick`;
  let r = await picker.call('POST', url, { picked: 4, override: { username: 'sal', pin: '0000' } });
  assert.equal(r.data.code, 'bad_override');
  r = await picker.call('POST', url, { picked: 4, override: { username: 'pia', pin: '1111' } });
  assert.match(r.data.error, /isn't a supervisor/);
  order = await picker.post(url, { picked: 4, override: { username: 'sal', pin: '2222' } });
  assert.equal(line('00735').picked, 4);
  const ev = (await boss.get(`/orders/${order.id}`)).events.find((e) => e.type === 'picked' && e.detail.approvedBy);
  assert.equal(ev.detail.approvedBy, 'Sal Super');
});

test('or the picker sends a request the supervisor approves or denies', async () => {
  const id = line('00439').id;
  order = await picker.post(`/orders/${order.id}/lines/${id}/request`, { picked: 3 });
  assert.equal(order.requests.length, 1);
  assert.equal((await picker.call('GET', '/approvals')).status, 403);
  let list = await boss.get('/approvals');
  assert.deepEqual(list.map((r) => [r.picker_name, r.description, r.from_qty, r.to_qty]), [['Pia Picker', 'MULTRA 24/12 CAN', 0, 3]]);
  assert.equal((await boss.get('/ping')).approvals, 1);
  await boss.post(`/approvals/${list[0].id}/approve`);
  order = await picker.get(`/orders/${order.id}`);
  assert.equal(line('00439').picked, 3);
  assert.equal(order.requests.length, 0);
  // A denied request changes nothing.
  order = await picker.post(`/orders/${order.id}/lines/${line('00735').id}/request`, { picked: 5 });
  list = await boss.get('/approvals');
  await boss.post(`/approvals/${list[0].id}/deny`);
  order = await picker.get(`/orders/${order.id}`);
  assert.equal(line('00735').picked, 4);
  assert.equal((await boss.call('POST', `/approvals/${list[0].id}/approve`)).status, 404, 'already handled');
});

test('pausing with a reason blocks picking until resumed, and pause time is not pick time', async () => {
  const reasons = (await picker.get('/me')).pauseReasons;
  assert.ok(reasons.includes('Break') && reasons.includes('Wrapping pallet') && reasons.includes('Getting a pallet of items down'));
  order = await picker.post(`/orders/${order.id}/pause`, { reason: 'Wrapping pallet' });
  assert.equal(order.pause_reason, 'Wrapping pallet');
  const r = await picker.call('POST', `/orders/${order.id}/lines/${line('00735').id}/pick`, { picked: 5, via: 'scan', barcode: '018200530302' });
  assert.equal(r.data.code, 'paused');
  assert.equal((await picker.call('POST', `/orders/${order.id}/submit`)).data.code, 'paused');
  const floor = await boss.get('/floor');
  assert.equal(floor.people.find((p) => p.name === 'Pia Picker').order.pause_reason, 'Wrapping pallet');
  // Pretend the pause lasted 20 minutes and picking started 30 minutes ago.
  const now = Date.now();
  run('UPDATE orders SET picking_since = ?, paused_at = ? WHERE id = ?', now - 30 * 60000, now - 20 * 60000, order.id);
  order = await picker.post(`/orders/${order.id}/resume`);
  assert.equal(order.paused_at, null);
  order = await picker.post(`/orders/${order.id}/lines/${line('00735').id}/pick`, { picked: 5, via: 'scan', barcode: '018200530302' });
  order = await picker.post(`/orders/${order.id}/submit`);
  assert.equal(order.status, 'done');
  const mins = (ms) => Math.round(ms / 60000);
  assert.equal(mins(order.pick_ms), 10, '30 minutes minus the 20-minute pause');
  assert.equal(mins(order.paused_total), 20);
});

test('pick rates leave paused time out', () => {
  const uid = one("SELECT id FROM users WHERE username = 'pia'").id;
  const dayId = Number(run('INSERT INTO days (started_at, ended_at) VALUES (0, 1)').lastInsertRowid);
  const oid = Number(run("INSERT INTO orders (day_id, load_no, store, status, created_at) VALUES (?, '201', 'X', 'done', 0)", dayId).lastInsertRowid);
  const t0 = 1_000_000_000_000;
  const min = 60000;
  const ev = (type, at, detail) => run('INSERT INTO events (order_id, user_id, type, detail, at) VALUES (?, ?, ?, ?, ?)', oid, uid, type, detail ? JSON.stringify(detail) : null, at);
  ev('started', t0);
  ev('picked', t0 + 5 * min, { from: 0, to: 10 });
  ev('paused', t0 + 6 * min, { reason: 'Break' });
  ev('resumed', t0 + 21 * min, { reason: 'Break' });
  ev('picked', t0 + 25 * min, { from: 10, to: 20 });
  ev('submitted', t0 + 26 * min);
  const [r] = rates.compute({ dayId, now: t0 + 60 * min });
  assert.equal(r.activeMs, 11 * min, '6 minutes before the break + 5 after; the 15-minute break is left out');
});

test('pause reasons are edited in Settings by an admin', async () => {
  assert.equal((await boss.call('PUT', '/settings/pause-reasons', { reasons: ['x'] })).status, 403);
  const r = await admin.put('/settings/pause-reasons', { reasons: ['Break', 'Wrapping pallet', 'Fire drill', 'Break', ''] });
  assert.deepEqual(r.pauseReasons, ['Break', 'Wrapping pallet', 'Fire drill']);
  assert.equal((await admin.call('PUT', '/settings/pause-reasons', { reasons: [] })).status, 400);
});

test('supervisors build the pick priority from specific items', async () => {
  assert.equal((await picker.call('PUT', '/settings/priority-list', { list: [] })).status, 403);
  const r = await boss.put('/settings/priority-list', { list: [
    { type: 'heading', label: '30 packs' }, { type: 'item', code: '00735' }, { type: 'item', code: '00735' },
    { type: 'heading', label: '' }, { type: 'item', code: '00439' }] });
  assert.deepEqual(r.pickPriorityList, [
    { type: 'heading', label: '30 packs' },
    { type: 'item', code: '00735', description: 'BUD LT 30/12 CAN' },
    { type: 'item', code: '00439', description: 'MULTRA 24/12 CAN' },
  ]);
  // Taking every item off goes back to the word rules.
  assert.equal((await boss.put('/settings/priority-list', { list: [{ type: 'heading', label: 'Empty' }] })).pickPriorityList, null);
});
