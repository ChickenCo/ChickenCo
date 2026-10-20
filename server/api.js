const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { one, all, run, tx, getSetting, setSetting, DATA_DIR, db } = require('./db');
const auth = require('./auth');
const push = require('./push');
const { normalizeBarcode, displayBarcode } = require('./barcode');
const demo = require('./demo');

const { requireRole, atLeast } = auth;
const api = express.Router();

const UNITS = ['CASES', 'BTLS', 'KEGS', 'MISC'];
const OUT_REASONS = { vip: 'Out on VIP sheet', out_of_stock: 'Out of stock', cant_find: "Can't find" };

// Bumped on every change; clients poll /api/ping and refresh when it moves.
let version = Date.now();
const changed = () => { version += 1; };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// Wraps handlers so thrown errors become JSON responses.
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong' });
  }
};

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : NaN);

function logEvent(orderId, userId, type, detail) {
  run('INSERT INTO events (order_id, user_id, type, detail, at) VALUES (?, ?, ?, ?, ?)',
    orderId, userId, type, detail ? JSON.stringify(detail) : null, Date.now());
}

// ---------- trucks ----------
const DEFAULT_TRUCKS = [1, 2, 3, 4, 5, 6].map((n) => ({ truck: n, load: String(200 + n) }));
const trucks = () => getSetting('trucks', DEFAULT_TRUCKS);
function truckForLoad(load) {
  const t = trucks().find((x) => x.load === String(load).trim());
  return t ? t.truck : null;
}
function loadForTruck(truck) {
  const t = trucks().find((x) => x.truck === int(truck));
  return t ? t.load : null;
}

// ---------- order helpers ----------
const ORDER_SELECT = `
  SELECT o.*, p.name AS picker_name, a.name AS approved_by_name,
    (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id) AS line_count,
    (SELECT COALESCE(SUM(qty), 0) FROM order_lines l WHERE l.order_id = o.id) AS units,
    (SELECT COALESCE(SUM(picked), 0) FROM order_lines l WHERE l.order_id = o.id) AS units_picked,
    (SELECT COALESCE(SUM(out_qty), 0) FROM order_lines l WHERE l.order_id = o.id) AS units_out,
    (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id AND l.picked + l.out_qty >= l.qty) AS lines_done,
    (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id AND l.out_qty > 0) AS lines_out,
    (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id AND l.out_status = 'pending') AS outs_pending
  FROM orders o
  LEFT JOIN users p ON p.id = o.picker_id
  LEFT JOIN users a ON a.id = o.approved_by`;

const withTruck = (o) => o && { ...o, truck: truckForLoad(o.load_no) };

function getOrder(id) {
  const o = withTruck(one(`${ORDER_SELECT} WHERE o.id = ?`, int(id)));
  if (!o) fail(404, 'Order not found');
  return o;
}

function orderDetail(id) {
  const o = getOrder(id);
  o.lines = all(`SELECT l.*, ob.name AS out_by_name, rb.name AS reviewed_by_name FROM order_lines l
    LEFT JOIN users ob ON ob.id = l.out_by LEFT JOIN users rb ON rb.id = l.reviewed_by
    WHERE l.order_id = ? ORDER BY l.seq`, o.id);
  return o;
}

function getLine(order, lineId) {
  const line = one('SELECT * FROM order_lines WHERE id = ? AND order_id = ?', int(lineId), order.id);
  if (!line) fail(404, 'Line not found');
  return line;
}

// Pickers may only change an order they have started; supervisors and up can always help.
function assertCanPick(req, order) {
  if (order.status === 'done') fail(409, 'This order is already finished');
  if (atLeast(req.user, 'supervisor')) return;
  if (order.status !== 'picking' || order.picker_id !== req.user.id) {
    fail(409, order.picker_id && order.picker_id !== req.user.id
      ? `${order.picker_name} is picking this order`
      : 'Tap "Start picking" first');
  }
}

// ---------- auth ----------
api.post('/login', h((req, res) => {
  const result = auth.login(req.body.username, req.body.pin);
  if (result.error) fail(401, result.error);
  auth.setSessionCookie(res, result.token, req);
  return { user: result.user };
}));

api.post('/logout', h((req, res) => {
  if (req.sessionToken) run('DELETE FROM sessions WHERE token = ?', req.sessionToken);
  auth.clearSessionCookie(res);
}));

api.use((req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in' })));

api.get('/me', h((req) => ({
  user: req.user,
  trucks: trucks(),
  vapidKey: push.publicKey(),
  version,
})));

api.get('/ping', h((req) => ({
  version,
  review: atLeast(req.user, 'supervisor') ? one("SELECT COUNT(*) n FROM orders WHERE status = 'review'").n : 0,
  pendingBarcodes: atLeast(req.user, 'supervisor') ? one("SELECT COUNT(*) n FROM item_barcodes WHERE status = 'pending'").n : 0,
})));

api.post('/me/pin', h((req) => {
  const u = one('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!auth.checkPin(req.body.current, u.pin_hash)) fail(400, 'Current PIN is wrong');
  if (!auth.validPin(req.body.pin)) fail(400, 'PIN must be 4 to 8 digits');
  run('UPDATE users SET pin_hash = ? WHERE id = ?', auth.hashPin(req.body.pin), u.id);
  run('DELETE FROM sessions WHERE user_id = ? AND token != ?', u.id, req.sessionToken);
}));

api.post('/push/subscribe', h((req) => { push.subscribe(req.user.id, req.body); }));
api.post('/push/unsubscribe', h((req) => { push.unsubscribe(str(req.body.endpoint, 1000)); }));

// ---------- trucks & orders ----------
api.get('/trucks', h((req) => {
  const since = int(req.query.since) || 0;
  const orders = all(`${ORDER_SELECT} WHERE o.status != 'done' OR o.completed_at >= ?`, since).map(withTruck);
  const list = trucks().map(({ truck, load }) => {
    const mine = orders.filter((o) => o.truck === truck);
    return {
      truck, load,
      orders: mine.length,
      open: mine.filter((o) => o.status === 'open').length,
      picking: mine.filter((o) => o.status === 'picking').length,
      review: mine.filter((o) => o.status === 'review').length,
      done: mine.filter((o) => o.status === 'done').length,
      units: mine.reduce((s, o) => s + o.units, 0),
      unitsDone: mine.reduce((s, o) => s + o.units_picked + o.units_out, 0),
    };
  });
  const unassigned = orders.filter((o) => o.truck == null).length;
  return { trucks: list, unassigned };
}));

api.get('/orders', h((req) => {
  const where = [];
  const params = [];
  if (req.query.truck === 'none') {
    const loads = trucks().map((t) => t.load);
    where.push(`o.load_no NOT IN (${loads.map(() => '?').join(',') || "''"})`);
    params.push(...loads);
  } else if (req.query.truck) {
    where.push('o.load_no = ?');
    params.push(loadForTruck(req.query.truck) ?? '__none__');
  }
  if (req.query.active) {
    where.push("(o.status != 'done' OR o.completed_at >= ?)");
    params.push(int(req.query.since) || 0);
  }
  if (req.query.status) {
    where.push('o.status = ?');
    params.push(str(req.query.status));
  }
  if (req.query.q) {
    where.push('(o.store LIKE ? OR o.stop LIKE ? OR o.account_no LIKE ? OR o.load_no LIKE ?)');
    const q = `%${str(req.query.q)}%`;
    params.push(q, q, q, q);
  }
  const sql = `${ORDER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE o.status WHEN 'done' THEN 1 ELSE 0 END, CAST(o.stop AS INTEGER), o.stop, o.id DESC LIMIT 500`;
  return all(sql, ...params).map(withTruck);
}));

api.get('/orders/:id', h((req) => {
  const o = orderDetail(req.params.id);
  if (atLeast(req.user, 'supervisor')) {
    o.events = all(`SELECT e.type, e.detail, e.at, u.name AS user_name FROM events e
      LEFT JOIN users u ON u.id = e.user_id WHERE e.order_id = ? ORDER BY e.at DESC LIMIT 200`, o.id)
      .map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
  }
  return o;
}));

function readOrderBody(body) {
  const header = {
    load_no: str(body.load_no, 20),
    stop: str(body.stop, 20),
    store: str(body.store),
    account_no: str(body.account_no, 40),
    address: str(body.address),
    city: str(body.city, 80),
    state: str(body.state, 20).toUpperCase(),
    day_no: str(body.day_no, 10),
    order_date: str(body.order_date, 20),
    zone: str(body.zone, 20),
  };
  if (!header.load_no && body.truck) header.load_no = loadForTruck(body.truck) || '';
  if (!header.load_no) fail(400, 'Choose a truck');
  if (!header.store) fail(400, 'Store name is required');
  const lines = (Array.isArray(body.lines) ? body.lines : []).map((l) => ({
    id: l.id ? int(l.id) : null,
    code: str(l.code, 40).toUpperCase(),
    description: str(l.description),
    qty: int(l.qty),
    unit: UNITS.includes(str(l.unit).toUpperCase()) ? str(l.unit).toUpperCase() : 'CASES',
    vipOut: !!l.vipOut,
  }));
  if (!lines.length) fail(400, 'Add at least one item');
  lines.forEach((l, i) => {
    if (!l.code) fail(400, `Line ${i + 1}: item code is required`);
    if (!(l.qty > 0)) fail(400, `Line ${i + 1}: quantity must be at least 1`);
    const item = one('SELECT * FROM items WHERE code = ?', l.code);
    if (!item && !l.description) fail(400, `Line ${i + 1}: ${l.code} is a new item, so it needs a description`);
    if (!l.description) l.description = item.description;
  });
  return { header, lines };
}

function saveLines(orderId, lines, userId) {
  const existing = all('SELECT * FROM order_lines WHERE order_id = ?', orderId);
  const keep = new Set();
  lines.forEach((l, i) => {
    // New codes typed on an order are added to the item list automatically.
    run('INSERT INTO items (code, description) VALUES (?, ?) ON CONFLICT(code) DO NOTHING', l.code, l.description);
    const prev = l.id && existing.find((e) => e.id === l.id);
    if (prev) {
      keep.add(prev.id);
      const picked = Math.min(prev.picked, l.qty);
      let outQty = Math.min(prev.out_qty, l.qty - picked);
      let outReason = outQty ? prev.out_reason : null;
      if (l.vipOut && !prev.out_qty) { outQty = l.qty - picked; outReason = 'vip'; }
      if (!l.vipOut && prev.out_reason === 'vip') { outQty = 0; outReason = null; }
      run(`UPDATE order_lines SET seq = ?, code = ?, description = ?, qty = ?, unit = ?, picked = ?, out_qty = ?,
           out_reason = ?, out_status = CASE WHEN ? > 0 THEN COALESCE(out_status, 'pending') ELSE NULL END WHERE id = ?`,
      i, l.code, l.description, l.qty, l.unit, picked, outQty, outReason, outQty, prev.id);
    } else {
      run(`INSERT INTO order_lines (order_id, seq, code, description, qty, unit, out_qty, out_reason, out_status, out_by, out_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      orderId, i, l.code, l.description, l.qty, l.unit,
      l.vipOut ? l.qty : 0, l.vipOut ? 'vip' : null, l.vipOut ? 'pending' : null, l.vipOut ? userId : null, l.vipOut ? Date.now() : null);
    }
  });
  existing.filter((e) => !keep.has(e.id)).forEach((e) => run('DELETE FROM order_lines WHERE id = ?', e.id));
}

api.post('/orders', requireRole('management'), h((req) => {
  const { header, lines } = readOrderBody(req.body);
  const id = tx(() => {
    const r = run(`INSERT INTO orders (load_no, stop, store, account_no, address, city, state, day_no, order_date, zone, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    header.load_no, header.stop, header.store, header.account_no, header.address, header.city, header.state,
    header.day_no, header.order_date, header.zone, req.user.id, Date.now());
    const orderId = Number(r.lastInsertRowid);
    saveLines(orderId, lines, req.user.id);
    logEvent(orderId, req.user.id, 'created');
    return orderId;
  });
  changed();
  return orderDetail(id);
}));

api.put('/orders/:id', requireRole('management'), h((req) => {
  const order = getOrder(req.params.id);
  const { header, lines } = readOrderBody(req.body);
  tx(() => {
    run(`UPDATE orders SET load_no = ?, stop = ?, store = ?, account_no = ?, address = ?, city = ?, state = ?,
      day_no = ?, order_date = ?, zone = ? WHERE id = ?`,
    header.load_no, header.stop, header.store, header.account_no, header.address, header.city, header.state,
    header.day_no, header.order_date, header.zone, order.id);
    saveLines(order.id, lines, req.user.id);
    logEvent(order.id, req.user.id, 'edited');
  });
  changed();
  return orderDetail(order.id);
}));

api.delete('/orders/:id', requireRole('management'), h((req) => {
  const order = getOrder(req.params.id);
  run('DELETE FROM orders WHERE id = ?', order.id);
  changed();
}));

api.post('/orders/:id/start', h((req) => {
  const order = getOrder(req.params.id);
  if (order.status === 'done') fail(409, 'This order is already finished');
  if (order.status === 'review') fail(409, 'This order is waiting for a supervisor');
  if (order.status === 'picking' && order.picker_id !== req.user.id) {
    fail(409, `${order.picker_name} is already picking this order`);
  }
  if (order.status !== 'picking') {
    run("UPDATE orders SET status = 'picking', picker_id = ?, started_at = COALESCE(started_at, ?) WHERE id = ?",
      req.user.id, Date.now(), order.id);
    logEvent(order.id, req.user.id, 'started');
    changed();
  }
  return orderDetail(order.id);
}));

api.post('/orders/:id/release', h((req) => {
  const order = getOrder(req.params.id);
  if (order.status !== 'picking') fail(409, 'This order is not being picked');
  if (order.picker_id !== req.user.id && !atLeast(req.user, 'supervisor')) fail(403, 'Only the picker or a supervisor can do that');
  run("UPDATE orders SET status = 'open', picker_id = NULL WHERE id = ?", order.id);
  logEvent(order.id, req.user.id, 'released');
  changed();
  return orderDetail(order.id);
}));

api.post('/orders/:id/assign', requireRole('supervisor'), h((req) => {
  const order = getOrder(req.params.id);
  if (order.status === 'done' || order.status === 'review') fail(409, 'Only open or in-progress orders can be assigned');
  const picker = one('SELECT * FROM users WHERE id = ? AND active = 1', int(req.body.userId));
  if (!picker) fail(400, 'Choose an employee');
  run("UPDATE orders SET status = 'picking', picker_id = ?, started_at = COALESCE(started_at, ?) WHERE id = ?",
    picker.id, Date.now(), order.id);
  logEvent(order.id, req.user.id, 'assigned', { to: picker.name });
  push.notifyUser(picker.id, { title: 'Order assigned to you', body: `Truck ${order.truck ?? '?'} · Stop ${order.stop} · ${order.store}`, url: `/#/order/${order.id}` });
  changed();
  return orderDetail(order.id);
}));

// Set how many have been picked on a line (absolute number).
api.post('/orders/:id/lines/:lineId/pick', h((req) => {
  const order = getOrder(req.params.id);
  assertCanPick(req, order);
  const line = getLine(order, req.params.lineId);
  const picked = int(req.body.picked);
  if (!(picked >= 0) || picked > line.qty) fail(400, `Quantity must be between 0 and ${line.qty}`);
  // Picking an item that was marked out reduces (or clears) the out.
  const outQty = Math.min(line.out_qty, line.qty - picked);
  run(`UPDATE order_lines SET picked = ?, out_qty = ?, out_reason = CASE WHEN ? > 0 THEN out_reason END,
       out_status = CASE WHEN ? > 0 THEN out_status END WHERE id = ?`, picked, outQty, outQty, outQty, line.id);
  logEvent(order.id, req.user.id, 'picked', { code: line.code, from: line.picked, to: picked, via: str(req.body.via, 10) || 'manual' });
  changed();
  return orderDetail(order.id);
}));

api.post('/orders/:id/lines/:lineId/out', h((req) => {
  const order = getOrder(req.params.id);
  assertCanPick(req, order);
  const line = getLine(order, req.params.lineId);
  const reason = str(req.body.reason);
  if (!['out_of_stock', 'cant_find'].includes(reason)) fail(400, 'Choose a reason');
  const remaining = line.qty - line.picked;
  const qty = int(req.body.qty);
  if (!(qty >= 1) || qty > remaining) fail(400, `Short quantity must be between 1 and ${remaining}`);
  run(`UPDATE order_lines SET out_qty = ?, out_reason = ?, out_status = 'pending', out_by = ?, out_at = ?,
       reviewed_by = NULL, reviewed_at = NULL WHERE id = ?`, qty, reason, req.user.id, Date.now(), line.id);
  logEvent(order.id, req.user.id, 'out', { code: line.code, qty, reason });
  changed();
  return orderDetail(order.id);
}));

api.post('/orders/:id/lines/:lineId/clear-out', h((req) => {
  const order = getOrder(req.params.id);
  assertCanPick(req, order);
  const line = getLine(order, req.params.lineId);
  run('UPDATE order_lines SET out_qty = 0, out_reason = NULL, out_status = NULL WHERE id = ?', line.id);
  logEvent(order.id, req.user.id, 'out_cleared', { code: line.code });
  changed();
  return orderDetail(order.id);
}));

api.post('/orders/:id/submit', h((req) => {
  const order = orderDetail(req.params.id);
  assertCanPick(req, order);
  const unfinished = order.lines.filter((l) => l.picked + l.out_qty < l.qty);
  if (unfinished.length) fail(400, `${unfinished.length} item${unfinished.length === 1 ? ' is' : 's are'} not picked or marked out yet`);
  const now = Date.now();
  const needsReview = order.lines.some((l) => l.out_qty > 0 && l.out_status !== 'confirmed');
  if (needsReview) {
    run("UPDATE orders SET status = 'review', submitted_at = ? WHERE id = ?", now, order.id);
    logEvent(order.id, req.user.id, 'submitted', { outs: order.lines.filter((l) => l.out_qty > 0).length });
    const outs = order.lines.filter((l) => l.out_qty > 0);
    push.notifyRole('supervisor', {
      title: `Outs to check · Truck ${order.truck ?? '?'} Stop ${order.stop}`,
      body: `${order.store}: ${outs.map((l) => `${l.description} (${l.out_qty})`).join(', ')}`.slice(0, 180),
      url: `/#/review/${order.id}`,
    });
  } else {
    run("UPDATE orders SET status = 'done', submitted_at = ?, completed_at = ? WHERE id = ?", now, now, order.id);
    logEvent(order.id, req.user.id, 'completed');
  }
  changed();
  return orderDetail(order.id);
}));

// ---------- supervisor review ----------
api.get('/review', requireRole('supervisor'), h(() => all(`${ORDER_SELECT} WHERE o.status = 'review' ORDER BY o.submitted_at`).map(withTruck)));

function reviewLine(req) {
  const order = getOrder(req.params.id);
  if (order.status !== 'review') fail(409, 'This order is not waiting for review');
  const line = getLine(order, req.params.lineId);
  if (!line.out_qty) fail(409, 'This item is not marked out');
  return { order, line };
}

api.post('/orders/:id/lines/:lineId/confirm-out', requireRole('supervisor'), h((req) => {
  const { order, line } = reviewLine(req);
  run("UPDATE order_lines SET out_status = 'confirmed', reviewed_by = ?, reviewed_at = ? WHERE id = ?", req.user.id, Date.now(), line.id);
  logEvent(order.id, req.user.id, 'out_confirmed', { code: line.code, qty: line.out_qty });
  changed();
  return orderDetail(order.id);
}));

// Supervisor found some or all of the missing product and added it to the order.
api.post('/orders/:id/lines/:lineId/found', requireRole('supervisor'), h((req) => {
  const { order, line } = reviewLine(req);
  const qty = int(req.body.qty);
  if (!(qty >= 1) || qty > line.out_qty) fail(400, `Found quantity must be between 1 and ${line.out_qty}`);
  const outQty = line.out_qty - qty;
  run(`UPDATE order_lines SET picked = picked + ?, out_qty = ?, out_reason = CASE WHEN ? > 0 THEN out_reason END,
       out_status = CASE WHEN ? > 0 THEN 'pending' END, reviewed_by = ?, reviewed_at = ? WHERE id = ?`,
  qty, outQty, outQty, outQty, req.user.id, Date.now(), line.id);
  logEvent(order.id, req.user.id, 'found', { code: line.code, qty });
  changed();
  return orderDetail(order.id);
}));

// Send a line back to the picker: the out is cleared and the order reopens for them.
api.post('/orders/:id/lines/:lineId/send-back', requireRole('supervisor'), h((req) => {
  const { order, line } = reviewLine(req);
  tx(() => {
    run('UPDATE order_lines SET out_qty = 0, out_reason = NULL, out_status = NULL, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
      req.user.id, Date.now(), line.id);
    run("UPDATE orders SET status = 'picking' WHERE id = ?", order.id);
    logEvent(order.id, req.user.id, 'sent_back', { code: line.code, note: str(req.body.note) });
  });
  if (order.picker_id) {
    push.notifyUser(order.picker_id, {
      title: 'Item sent back to you',
      body: `${line.description} for ${order.store} (Stop ${order.stop}) was found. Please pick it.`,
      url: `/#/order/${order.id}`,
    });
  }
  changed();
  return orderDetail(order.id);
}));

api.post('/orders/:id/approve', requireRole('supervisor'), h((req) => {
  const order = orderDetail(req.params.id);
  if (order.status !== 'review') fail(409, 'This order is not waiting for review');
  if (order.lines.some((l) => l.out_qty > 0 && l.out_status !== 'confirmed')) fail(400, 'Confirm or resolve every out first');
  const now = Date.now();
  run("UPDATE orders SET status = 'done', approved_by = ?, completed_at = ? WHERE id = ?", req.user.id, now, order.id);
  logEvent(order.id, req.user.id, 'approved');
  changed();
  return orderDetail(order.id);
}));

// Management can reopen a finished order (e.g. a mistake was found on the dock).
api.post('/orders/:id/reopen', requireRole('management'), h((req) => {
  const order = getOrder(req.params.id);
  run(`UPDATE orders SET status = CASE WHEN picker_id IS NULL THEN 'open' ELSE 'picking' END,
       completed_at = NULL, approved_by = NULL WHERE id = ?`, order.id);
  run("UPDATE order_lines SET out_status = 'pending' WHERE order_id = ? AND out_qty > 0", order.id);
  logEvent(order.id, req.user.id, 'reopened');
  changed();
  return orderDetail(order.id);
}));

// ---------- barcodes ----------
function barcodeLookup(raw, format) {
  const gtin = normalizeBarcode(raw, format);
  if (!gtin) fail(400, 'Empty barcode');
  const row = one(`SELECT b.gtin, b.status, i.code, i.description FROM item_barcodes b
    JOIN items i ON i.code = b.code WHERE b.gtin = ?`, gtin);
  return { gtin, display: displayBarcode(gtin), item: row ? { code: row.code, description: row.description } : null, status: row?.status };
}

api.get('/barcodes/lookup', h((req) => barcodeLookup(req.query.raw, req.query.format)));

// Link a barcode to an item. Pickers' links are "pending" until a supervisor confirms them.
api.post('/barcodes', h((req) => {
  const gtin = normalizeBarcode(req.body.raw, req.body.format);
  if (!gtin) fail(400, 'Empty barcode');
  const item = one('SELECT * FROM items WHERE code = ?', str(req.body.code).toUpperCase());
  if (!item) fail(404, 'Item not found');
  const existing = one('SELECT * FROM item_barcodes WHERE gtin = ?', gtin);
  const trusted = atLeast(req.user, 'supervisor');
  if (existing && existing.code !== item.code) {
    if (!atLeast(req.user, 'management')) fail(409, `That barcode already belongs to item ${existing.code}`);
    run('DELETE FROM item_barcodes WHERE gtin = ?', gtin);
  } else if (existing) {
    if (trusted && existing.status === 'pending') run("UPDATE item_barcodes SET status = 'confirmed' WHERE gtin = ?", gtin);
    changed();
    return barcodeLookup(gtin);
  }
  run('INSERT INTO item_barcodes (gtin, code, status, added_by, created_at) VALUES (?, ?, ?, ?, ?)',
    gtin, item.code, trusted ? 'confirmed' : 'pending', req.user.id, Date.now());
  changed();
  return barcodeLookup(gtin);
}));

api.get('/barcodes/pending', requireRole('supervisor'), h(() => all(`SELECT b.gtin, b.code, b.created_at, i.description, u.name AS added_by_name
  FROM item_barcodes b JOIN items i ON i.code = b.code LEFT JOIN users u ON u.id = b.added_by
  WHERE b.status = 'pending' ORDER BY b.created_at`).map((b) => ({ ...b, display: displayBarcode(b.gtin) }))));

api.post('/barcodes/:gtin/confirm', requireRole('supervisor'), h((req) => {
  run("UPDATE item_barcodes SET status = 'confirmed' WHERE gtin = ?", req.params.gtin);
  changed();
}));

api.delete('/barcodes/:gtin', requireRole('supervisor'), h((req) => {
  const b = one('SELECT * FROM item_barcodes WHERE gtin = ?', req.params.gtin);
  if (!b) fail(404, 'Barcode not found');
  if (b.status === 'confirmed' && !atLeast(req.user, 'management')) fail(403, 'Only management can remove a confirmed barcode');
  run('DELETE FROM item_barcodes WHERE gtin = ?', b.gtin);
  changed();
}));

// ---------- items ----------
function itemsWithBarcodes(where = '', ...params) {
  const items = all(`SELECT * FROM items ${where} ORDER BY code LIMIT 2000`, ...params);
  const codes = new Map(items.map((i) => [i.code, { ...i, barcodes: [] }]));
  if (items.length) {
    all('SELECT gtin, code, status FROM item_barcodes').forEach((b) => {
      const it = codes.get(b.code);
      if (it) it.barcodes.push({ gtin: b.gtin, display: displayBarcode(b.gtin), status: b.status });
    });
  }
  return [...codes.values()];
}

api.get('/items', h((req) => {
  if (req.query.q) {
    const q = `%${str(req.query.q)}%`;
    return itemsWithBarcodes('WHERE code LIKE ? OR description LIKE ?', q, q);
  }
  return itemsWithBarcodes();
}));

api.post('/items', requireRole('management'), h((req) => {
  const code = str(req.body.code, 40).toUpperCase();
  const description = str(req.body.description);
  const original = str(req.body.originalCode, 40).toUpperCase();
  if (!code) fail(400, 'Item code is required');
  if (!description) fail(400, 'Description is required');
  const clash = one('SELECT code FROM items WHERE code = ?', code);
  if (original) {
    if (clash && code !== original) fail(409, `Item ${code} already exists`);
    if (!one('SELECT code FROM items WHERE code = ?', original)) fail(404, 'Item not found');
    run('UPDATE items SET code = ?, description = ? WHERE code = ?', code, description, original);
  } else {
    if (clash) fail(409, `Item ${code} already exists`);
    run('INSERT INTO items (code, description) VALUES (?, ?)', code, description);
  }
  changed();
  return itemsWithBarcodes('WHERE code = ?', code)[0];
}));

api.delete('/items/:code', requireRole('management'), h((req) => {
  run('DELETE FROM items WHERE code = ?', str(req.params.code).toUpperCase());
  changed();
}));

// Paste from a spreadsheet: code, description[, barcode[, barcode...]]
api.post('/items/import', requireRole('management'), h((req) => {
  let added = 0, updated = 0, barcodes = 0, skipped = 0;
  tx(() => {
    String(req.body.text || '').split(/\r?\n/).forEach((lineText) => {
      if (!lineText.trim()) return;
      const cells = lineText.split(/\t|,/).map((c) => c.trim().replace(/^"|"$/g, ''));
      const [code, description, ...codes] = cells;
      if (/^(code|item|sku)/i.test(code || '')) return; // header row
      if (!code || !description) { skipped++; return; }
      const up = code.toUpperCase();
      const exists = one('SELECT code FROM items WHERE code = ?', up);
      if (exists) { run('UPDATE items SET description = ? WHERE code = ?', description, up); updated++; }
      else { run('INSERT INTO items (code, description) VALUES (?, ?)', up, description); added++; }
      codes.filter(Boolean).forEach((raw) => {
        const gtin = normalizeBarcode(raw);
        if (!gtin) return;
        run(`INSERT INTO item_barcodes (gtin, code, status, added_by, created_at) VALUES (?, ?, 'confirmed', ?, ?)
             ON CONFLICT(gtin) DO UPDATE SET code = excluded.code, status = 'confirmed'`, gtin, up, req.user.id, Date.now());
        barcodes++;
      });
    });
  });
  changed();
  return { added, updated, barcodes, skipped };
}));

// ---------- users ----------
api.get('/employees', requireRole('supervisor'), h(() =>
  all('SELECT id, name, username, role FROM users WHERE active = 1 ORDER BY name')));

api.get('/users', requireRole('admin'), h(() =>
  all('SELECT id, username, name, role, active, created_at FROM users ORDER BY active DESC, name')
    .map((u) => ({ ...u, active: !!u.active }))));

api.post('/users', requireRole('admin'), h((req) => {
  const username = str(req.body.username, 40).toLowerCase();
  const name = str(req.body.name, 80);
  const role = str(req.body.role);
  if (!/^[a-z0-9._-]{2,40}$/.test(username)) fail(400, 'Username: 2+ letters or numbers, no spaces');
  if (!name) fail(400, 'Name is required');
  if (!auth.ROLES.includes(role)) fail(400, 'Choose a role');
  if (!auth.validPin(req.body.pin)) fail(400, 'PIN must be 4 to 8 digits');
  if (one('SELECT id FROM users WHERE username = ?', username)) fail(409, 'That username is taken');
  run('INSERT INTO users (username, name, pin_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
    username, name, auth.hashPin(req.body.pin), role, Date.now());
}));

api.put('/users/:id', requireRole('admin'), h((req) => {
  const u = one('SELECT * FROM users WHERE id = ?', int(req.params.id));
  if (!u) fail(404, 'User not found');
  const name = str(req.body.name, 80) || u.name;
  const role = auth.ROLES.includes(req.body.role) ? req.body.role : u.role;
  const active = req.body.active === undefined ? !!u.active : !!req.body.active;
  const admins = one("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").n;
  if (u.role === 'admin' && u.active && (role !== 'admin' || !active) && admins <= 1) fail(400, 'There must be at least one active admin');
  run('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?', name, role, active ? 1 : 0, u.id);
  if (req.body.pin) {
    if (!auth.validPin(req.body.pin)) fail(400, 'PIN must be 4 to 8 digits');
    run('UPDATE users SET pin_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', auth.hashPin(req.body.pin), u.id);
  }
  // Signing out a deactivated or re-PINned user everywhere.
  if (!active || req.body.pin) run('DELETE FROM sessions WHERE user_id = ? AND token != ?', u.id, req.sessionToken || '');
}));

// ---------- settings ----------
api.put('/settings/trucks', requireRole('admin'), h((req) => {
  const list = (Array.isArray(req.body.trucks) ? req.body.trucks : []).map((t) => ({ truck: int(t.truck), load: str(t.load, 20) }));
  if (!list.length || list.some((t) => !(t.truck > 0) || !t.load)) fail(400, 'Every truck needs a number and a load #');
  if (new Set(list.map((t) => t.load)).size !== list.length) fail(400, 'Each load # can only belong to one truck');
  if (new Set(list.map((t) => t.truck)).size !== list.length) fail(400, 'Truck numbers must be different');
  setSetting('trucks', list.sort((a, b) => a.truck - b.truck));
  changed();
  return trucks();
}));

// ---------- reports ----------
api.get('/reports/outs', requireRole('management'), h((req) => {
  const from = int(req.query.from) || 0;
  const to = int(req.query.to) || Date.now();
  return all(`SELECT o.id AS order_id, o.load_no, o.stop, o.store, o.order_date, o.status, l.code, l.description, l.qty,
      l.out_qty, l.out_reason, l.out_status, l.out_at, ob.name AS out_by_name, rb.name AS reviewed_by_name, l.reviewed_at
    FROM order_lines l JOIN orders o ON o.id = l.order_id
    LEFT JOIN users ob ON ob.id = l.out_by LEFT JOIN users rb ON rb.id = l.reviewed_by
    WHERE l.out_qty > 0 AND COALESCE(l.out_at, o.created_at) BETWEEN ? AND ?
    ORDER BY l.out_at DESC`, from, to).map((r) => ({ ...r, truck: truckForLoad(r.load_no), reason_label: OUT_REASONS[r.out_reason] || r.out_reason }));
}));

api.get('/reports/orders', requireRole('management'), h((req) => {
  const from = int(req.query.from) || 0;
  const to = int(req.query.to) || Date.now();
  return all(`${ORDER_SELECT} WHERE o.status = 'done' AND o.completed_at BETWEEN ? AND ? ORDER BY o.completed_at DESC`, from, to).map(withTruck);
}));

// ---------- admin tools ----------
api.get('/admin/backup', requireRole('admin'), h((req, res) => {
  const file = path.join(DATA_DIR, `backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  res.download(file, `pick-backup-${new Date().toISOString().slice(0, 10)}.db`, () => fs.unlink(file, () => {}));
}));

api.post('/admin/demo', requireRole('admin'), h(() => {
  const result = tx(() => demo.load({ hashPin: auth.hashPin }));
  changed();
  return result;
}));

api.post('/admin/test-run', requireRole('admin'), h(() => {
  const result = tx(() => demo.addChucksTestRun());
  changed();
  return result;
}));

module.exports = api;
