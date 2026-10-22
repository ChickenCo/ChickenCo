// Work days. There's no fixed schedule: a day starts with its first order and ends
// when every order on every truck is done. The next order after that starts a new day.
const { one, all, run } = require('./db');
const push = require('./push');

function openDayId() {
  const open = one('SELECT id FROM days WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1');
  if (open) return open.id;
  return Number(run('INSERT INTO days (started_at) VALUES (?)', Date.now()).lastInsertRowid);
}

// The day the Trucks screen shows: the one in progress, or the last finished one until a new order arrives.
const displayDay = () => one('SELECT * FROM days ORDER BY ended_at IS NULL DESC, id DESC LIMIT 1') || null;

function totals(dayId) {
  return one(`SELECT COUNT(DISTINCT o.id) AS orders,
      COUNT(DISTINCT CASE WHEN o.status = 'done' THEN o.id END) AS orders_done,
      COALESCE(SUM(l.qty), 0) AS cases, COALESCE(SUM(l.picked), 0) AS picked, COALESCE(SUM(l.out_qty), 0) AS outs
    FROM orders o LEFT JOIN order_lines l ON l.order_id = o.id WHERE o.day_id = ?`, dayId);
}

function topSellers(dayId, limit = 10) {
  return all(`SELECT l.code, MAX(l.description) AS description, SUM(l.picked) AS cases, COUNT(DISTINCT o.id) AS stores
    FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE o.day_id = ? AND l.picked > 0 GROUP BY l.code ORDER BY cases DESC, l.code LIMIT ?`, dayId, limit);
}

function mostOut(dayId, limit = 10) {
  return all(`SELECT l.code, MAX(l.description) AS description, SUM(l.out_qty) AS cases, COUNT(DISTINCT o.id) AS stores
    FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE o.day_id = ? AND l.out_qty > 0 GROUP BY l.code ORDER BY cases DESC, l.code LIMIT ?`, dayId, limit);
}

function summary(day) {
  if (!day) return null;
  const t = totals(day.id);
  return {
    ...day,
    totals: { ...t, left: Math.max(0, t.cases - t.picked - t.outs) },
    // Top sellers and outs are shown once the trucks are done.
    top: day.ended_at ? topSellers(day.id) : null,
    mostOut: day.ended_at ? mostOut(day.id) : null,
  };
}

// Call after an order finishes or is deleted. Closes the day when nothing is left to pick.
function closeIfDone(dayId) {
  if (!dayId) return false;
  const day = one('SELECT * FROM days WHERE id = ?', dayId);
  if (!day || day.ended_at) return false;
  const left = one(`SELECT COUNT(*) AS total, SUM(status != 'done') AS open FROM orders WHERE day_id = ?`, dayId);
  if (!left.total || left.open) return false;
  run('UPDATE days SET ended_at = ? WHERE id = ?', Date.now(), dayId);
  const t = totals(dayId);
  const [top] = topSellers(dayId, 1);
  const [worst] = mostOut(dayId, 1);
  push.notifyRole('management', {
    title: 'All trucks loaded',
    body: `${t.cases.toLocaleString()} cases on ${t.orders} orders · ${t.outs} out`
      + `${top ? ` · Top seller: ${top.description} (${top.cases})` : ''}${worst ? ` · Most out: ${worst.description} (${worst.cases})` : ''}`,
    url: '/#/',
  });
  return true;
}

// Reopening a finished order puts its day back in progress.
function reopen(dayId) {
  if (dayId) run('UPDATE days SET ended_at = NULL WHERE id = ?', dayId);
}

function list(limit = 60) {
  return all('SELECT * FROM days ORDER BY id DESC LIMIT ?', limit).map((d) => {
    const t = totals(d.id);
    const [top] = topSellers(d.id, 1);
    return { ...d, totals: t, topSeller: top || null };
  });
}

module.exports = { openDayId, displayDay, summary, closeIfDone, reopen, list, topSellers, mostOut };
