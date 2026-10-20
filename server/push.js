// Web push notifications (iPhone: works once the app is added to the Home Screen, iOS 16.4+).
const webpush = require('web-push');
const { all, run, getSetting, setSetting } = require('./db');
const { RANK } = require('./auth');

function vapidKeys() {
  let keys = getSetting('vapid');
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    setSetting('vapid', keys);
  }
  return keys;
}

const keys = vapidKeys();
webpush.setVapidDetails(process.env.PUSH_CONTACT || 'mailto:admin@example.com', keys.publicKey, keys.privateKey);

const publicKey = () => keys.publicKey;

function subscribe(userId, sub) {
  if (!sub || !sub.endpoint) throw new Error('Invalid subscription');
  run(`INSERT INTO push_subscriptions (endpoint, user_id, subscription, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, subscription = excluded.subscription`,
  sub.endpoint, userId, JSON.stringify(sub), Date.now());
}

function unsubscribe(endpoint) {
  run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
}

async function sendTo(rows, payload) {
  const body = JSON.stringify(payload);
  await Promise.all(rows.map(async (r) => {
    try {
      await webpush.sendNotification(JSON.parse(r.subscription), body);
    } catch (err) {
      // Expired or revoked subscriptions get cleaned up.
      if (err.statusCode === 404 || err.statusCode === 410) unsubscribe(r.endpoint);
      else console.warn('push failed', err.statusCode || err.message);
    }
  }));
}

// Everyone at or above `role` who turned notifications on.
function notifyRole(role, payload) {
  const roles = Object.keys(RANK).filter((r) => RANK[r] >= RANK[role]);
  const rows = all(`SELECT p.* FROM push_subscriptions p JOIN users u ON u.id = p.user_id
    WHERE u.active = 1 AND u.role IN (${roles.map(() => '?').join(',')})`, ...roles);
  return sendTo(rows, payload).catch(() => {});
}

function notifyUser(userId, payload) {
  return sendTo(all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId), payload).catch(() => {});
}

module.exports = { publicKey, subscribe, unsubscribe, notifyRole, notifyUser };
