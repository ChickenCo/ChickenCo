// SQLite storage (Node's built-in node:sqlite). One file on disk: $DATA_DIR/pick.db
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'pick.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('picker','supervisor','management','admin')),
    active INTEGER NOT NULL DEFAULT 1,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    code TEXT PRIMARY KEY,
    description TEXT NOT NULL
  );

  -- Barcodes are stored as 14-digit GTINs so UPC-A, EAN-13 and case ITF-14 codes compare equal.
  CREATE TABLE IF NOT EXISTS item_barcodes (
    gtin TEXT PRIMARY KEY,
    code TEXT NOT NULL REFERENCES items(code) ON UPDATE CASCADE ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','pending')),
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS item_barcodes_code ON item_barcodes(code);

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    load_no TEXT NOT NULL,
    stop TEXT NOT NULL DEFAULT '',
    store TEXT NOT NULL,
    account_no TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    day_no TEXT NOT NULL DEFAULT '',
    order_date TEXT NOT NULL DEFAULT '',
    zone TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','picking','review','done')),
    picker_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    started_at INTEGER,
    submitted_at INTEGER,
    approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    completed_at INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_status ON orders(status);

  CREATE TABLE IF NOT EXISTS order_lines (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    code TEXT NOT NULL,
    description TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty > 0),
    unit TEXT NOT NULL DEFAULT 'CASES',
    picked INTEGER NOT NULL DEFAULT 0,
    out_qty INTEGER NOT NULL DEFAULT 0,
    out_reason TEXT,             -- 'vip' | 'out_of_stock' | 'cant_find'
    out_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    out_at INTEGER,
    out_status TEXT,             -- NULL | 'pending' | 'confirmed'
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS order_lines_order ON order_lines(order_id);

  -- Activity log: who did what to which order. Drives the reports.
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    detail TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_order ON events(order_id);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSetting(key, fallback) {
  const row = one('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : fallback;
}

function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, JSON.stringify(value));
}

module.exports = { db, one, all, run, tx, getSetting, setSetting, DATA_DIR };
