// SQLite storage (Node's built-in node:sqlite). One file on disk: $DATA_DIR/pick.db
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'pick.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const usersTable = (name) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('driver','picker','supervisor','management','admin')),
    active INTEGER NOT NULL DEFAULT 1,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL
  );`;

db.exec(`
  ${usersTable('users')}

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

  -- A work day has no fixed hours: it ends when every order on every truck is done.
  CREATE TABLE IF NOT EXISTS days (
    id INTEGER PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    day_id INTEGER REFERENCES days(id),
    is_test INTEGER NOT NULL DEFAULT 0, -- demo data and practice runs (left out of pick rates)
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

  -- Notes for pickers and loaders: on one order, on every order for a store, or on a truck's load.
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('order','store','truck')),
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    store_key TEXT,
    truck INTEGER,
    day_id INTEGER REFERENCES days(id) ON DELETE CASCADE, -- truck notes: NULL means every day
    text TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notes_order ON notes(order_id);

  CREATE TABLE IF NOT EXISTS pin_requests (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );

  -- One alert per item per day when it's marked out on several orders.
  CREATE TABLE IF NOT EXISTS out_alerts (
    day_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    orders INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (day_id, code)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

// Upgrade databases created before the driver role existed (SQLite can't alter a CHECK in place).
if (!one("SELECT sql FROM sqlite_master WHERE name = 'users'").sql.includes("'driver'")) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`BEGIN; ${usersTable('users_new')}
    INSERT INTO users_new SELECT id, username, name, pin_hash, role, active, failed_logins, locked_until, created_at FROM users;
    DROP TABLE users; ALTER TABLE users_new RENAME TO users; COMMIT;`);
  db.exec('PRAGMA foreign_keys = ON');
}

// Upgrade databases created before work days existed.
const orderCols = all('PRAGMA table_info(orders)').map((c) => c.name);
if (!orderCols.includes('day_id')) db.exec('ALTER TABLE orders ADD COLUMN day_id INTEGER REFERENCES days(id)');
if (!orderCols.includes('is_test')) {
  db.exec('ALTER TABLE orders ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE orders SET is_test = 1 WHERE created_by IS NULL'); // demo + test-run orders
}
db.exec('CREATE INDEX IF NOT EXISTS orders_day ON orders(day_id)');
const loose = one(`SELECT COUNT(*) n, MIN(created_at) first, MAX(completed_at) last,
  SUM(status != 'done') open FROM orders WHERE day_id IS NULL`);
if (loose.n) {
  const r = run('INSERT INTO days (started_at, ended_at) VALUES (?, ?)', loose.first, loose.open ? null : loose.last);
  run('UPDATE orders SET day_id = ? WHERE day_id IS NULL', Number(r.lastInsertRowid));
}

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

// Remember when this database file was first created. If it keeps being "new" after
// restarts, the data folder is not on a persistent disk and everything is being wiped.
if (!one("SELECT 1 FROM settings WHERE key = 'db_created_at'")) setSetting('db_created_at', Date.now());

// On a hosted server, a real disk shows up as a separate device mounted at DATA_DIR.
// If DATA_DIR sits on the container's own filesystem, it is erased on every restart or deploy.
function storageWarning() {
  const hosted = process.env.RENDER || process.env.DATA_DIR === '/data';
  if (!hosted) return null;
  try {
    if (fs.statSync(DATA_DIR).dev !== fs.statSync('/').dev) return null;
  } catch { return null; }
  return `No persistent disk is mounted at ${DATA_DIR}. Employees, orders and items are erased every time the server restarts or updates; only the admin login comes back. Add a disk mounted at ${DATA_DIR} (Render: service › Disks, Starter plan or higher).`;
}
const STORAGE_WARNING = storageWarning();
if (STORAGE_WARNING) console.warn(`WARNING: ${STORAGE_WARNING}`);

module.exports = { db, one, all, run, tx, getSetting, setSetting, DATA_DIR, STORAGE_WARNING };
