// Pick rate: cases picked per hour of active picking, worked out from the order history.
// Active time runs from "Start picking" until the picker stops, finishes or sends the order on.
// A gap of more than 10 minutes with no scans counts as only 10 minutes, so breaks don't drag the rate down.
const { all, getSetting } = require('./db');

const MAX_GAP = 10 * 60 * 1000;
const MIN_ACTIVE = 5 * 60 * 1000; // under 5 minutes of picking is too little to show a rate
const DEFAULT_TARGET = 100;

const target = () => getSetting('pick_rate_min', DEFAULT_TARGET);
// On while this is a proof of concept so demo picking shows up; turn off for real use.
const includeTests = () => getSetting('rates_include_tests', true);

// dayId: one work day; since: history from this time on. Test/demo orders are left out unless asked.
function compute({ dayId, since, includeTests = false, now = Date.now() }) {
  const where = ['1 = 1'];
  const params = [];
  if (dayId) { where.push('o.day_id = ?'); params.push(dayId); }
  if (since) { where.push('e.at >= ?'); params.push(since); }
  if (!includeTests) where.push('o.is_test = 0');
  const events = all(`SELECT e.order_id, e.user_id, e.type, e.detail, e.at, o.picker_id
    FROM events e JOIN orders o ON o.id = e.order_id
    WHERE ${where.join(' AND ')} ORDER BY e.order_id, e.at, e.id`, ...params);

  const stats = new Map();
  const get = (id) => {
    if (!stats.has(id)) stats.set(id, { userId: id, cases: 0, activeMs: 0, orders: new Set(), outs: 0, foundOnShelf: 0 });
    return stats.get(id);
  };

  let orderId = null;
  let active = null; // { user, last }
  const advance = (at) => {
    if (!active) return;
    get(active.user).activeMs += Math.min(Math.max(0, at - active.last), MAX_GAP);
    active.last = at;
  };

  for (const e of events) {
    if (e.order_id !== orderId) {
      // Still being picked right now: count the time since the last scan (capped).
      if (orderId !== null && active) advance(now);
      active = null;
      orderId = e.order_id;
    }
    const d = e.detail ? JSON.parse(e.detail) : {};
    switch (e.type) {
      case 'started':
        advance(e.at);
        active = { user: e.user_id, last: e.at };
        get(e.user_id).orders.add(e.order_id);
        break;
      case 'assigned':
        advance(e.at);
        if (d.toId) { active = { user: d.toId, last: e.at }; get(d.toId).orders.add(e.order_id); }
        break;
      case 'sent_back':
        if (d.outBy && d.reason !== 'vip') get(d.outBy).foundOnShelf += 1;
        if (d.pickerId) active = { user: d.pickerId, last: e.at };
        break;
      case 'found':
        if (d.outBy && d.reason !== 'vip') get(d.outBy).foundOnShelf += 1;
        break;
      case 'picked':
        if (active && active.user === e.user_id) advance(e.at);
        get(e.user_id).cases += (d.to ?? 0) - (d.from ?? 0);
        get(e.user_id).orders.add(e.order_id);
        break;
      case 'out':
        if (active && active.user === e.user_id) advance(e.at);
        get(e.user_id).outs += 1;
        break;
      case 'out_cleared':
        if (active && active.user === e.user_id) advance(e.at);
        break;
      case 'released':
      case 'submitted':
      case 'completed':
        advance(e.at);
        active = null;
        break;
      default:
    }
  }
  if (active) advance(now);

  const users = new Map(all('SELECT id, name, role, active FROM users').map((u) => [u.id, u]));
  return [...stats.values()]
    .filter((s) => users.has(s.userId) && (s.cases > 0 || s.activeMs > 0))
    .map((s) => ({
      userId: s.userId,
      name: users.get(s.userId).name,
      role: users.get(s.userId).role,
      cases: s.cases,
      activeMs: s.activeMs,
      orders: s.orders.size,
      outs: s.outs,
      foundOnShelf: s.foundOnShelf,
      rate: s.activeMs >= MIN_ACTIVE ? Math.round(s.cases / (s.activeMs / 3600000)) : null,
    }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.cases - a.cases);
}

module.exports = { compute, target, includeTests, DEFAULT_TARGET, MAX_GAP, MIN_ACTIVE };
