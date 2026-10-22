// Username + PIN logins. Accounts are created by an admin; no email involved.
const crypto = require('node:crypto');
const { one, run } = require('./db');

// Drivers rank below pickers: they can see orders and leave notes but not pick.
const ROLES = ['driver', 'picker', 'supervisor', 'management', 'admin'];
const RANK = Object.fromEntries(ROLES.map((r, i) => [r, i]));
const COOKIE = 'pick_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function checkPin(pin, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function validPin(pin) {
  return /^\d{4,8}$/.test(String(pin || ''));
}

const publicUser = (u) => u && { id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active };

function login(username, pin) {
  const u = one('SELECT * FROM users WHERE username = ?', String(username || '').trim());
  const now = Date.now();
  if (!u || !u.active) return { error: 'Wrong username or PIN' };
  if (u.locked_until && u.locked_until > now) {
    const mins = Math.ceil((u.locked_until - now) / 60000);
    return { error: `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
  }
  if (!checkPin(pin, u.pin_hash)) {
    const fails = u.failed_logins + 1;
    run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?',
      fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? now + LOCK_MS : null, u.id);
    return { error: 'Wrong username or PIN' };
  }
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', u.id);
  const token = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)', token, u.id, now, now);
  return { token, user: publicUser(u) };
}

function parseCookies(header) {
  return Object.fromEntries((header || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function setSessionCookie(res, token, req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Express middleware: attaches req.user when the session cookie is valid.
function loadUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = one(`SELECT u.*, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token);
    const now = Date.now();
    if (row && row.active && now - row.last_seen < SESSION_DAYS * 86400000) {
      req.user = publicUser(row);
      req.sessionToken = token;
      // Sliding expiry; only touch the row occasionally.
      if (now - row.last_seen > 3600000) run('UPDATE sessions SET last_seen = ? WHERE token = ?', now, token);
    }
  }
  next();
}

const atLeast = (user, role) => !!user && RANK[user.role] >= RANK[role];

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in' });
    if (!atLeast(req.user, role)) return res.status(403).json({ error: 'You do not have permission to do that' });
    next();
  };
}

// First start: make sure an admin exists so someone can sign in.
function ensureAdmin() {
  const count = one('SELECT COUNT(*) AS n FROM users').n;
  if (count > 0) return;
  const pin = process.env.ADMIN_PIN || '1234';
  run('INSERT INTO users (username, name, pin_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
    'admin', 'Administrator', hashPin(pin), 'admin', Date.now());
  console.log(`Created first admin account: username "admin", PIN ${process.env.ADMIN_PIN ? '(from ADMIN_PIN)' : '1234'}. Change it after signing in.`);
}

module.exports = {
  ROLES, RANK, hashPin, checkPin, validPin, login, loadUser, requireRole, atLeast,
  setSessionCookie, clearSessionCookie, publicUser, ensureAdmin,
};
