// Employee accounts: an admin creates logins for every role and each one can sign in.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-accounts-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ADMIN_PIN = '2580';
process.env.RENDER = 'true'; // pretend to be hosted with no disk attached
const app = require('../server/app');

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
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test('employees created by the admin can sign in, in every role', async () => {
  const admin = await call('POST', '/login', { username: 'admin', pin: '2580' });
  assert.equal(admin.status, 200);
  const people = [
    ['Sam Rivers', 'srivers', 'picker', '2468'],
    ['Pat Lane', 'plane', 'supervisor', '1357'],
    ['Jo Park', 'jpark', 'management', '8642'],
    ['Lee Fox', 'lfox', 'admin', '97531'],
  ];
  for (const [name, username, role, pin] of people) {
    const made = await call('POST', '/users', { name, username, role, pin }, admin.cookie);
    assert.equal(made.status, 200, `create ${username}: ${JSON.stringify(made.data)}`);
    // Typed on a phone: capital first letter and a stray space still work.
    const typed = ` ${username[0].toUpperCase()}${username.slice(1)} `;
    const login = await call('POST', '/login', { username: typed, pin });
    assert.equal(login.status, 200, `${username} should sign in`);
    assert.equal(login.data.user.role, role);
    const me = await call('GET', '/me', undefined, login.cookie);
    assert.equal(me.data.user.username, username);
    const trucks = await call('GET', '/trucks', undefined, login.cookie);
    assert.equal(trucks.status, 200);
  }
  const wrong = await call('POST', '/login', { username: 'srivers', pin: '0000' });
  assert.equal(wrong.status, 401);
});

test('usernames with spaces are rejected with a clear message', async () => {
  const admin = await call('POST', '/login', { username: 'admin', pin: '2580' });
  const r = await call('POST', '/users', { name: 'Kim Day', username: 'Kim Day', role: 'picker', pin: '1111' }, admin.cookie);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no spaces/);
});

test('admin is warned when the data folder is not on a persistent disk', async () => {
  const admin = await call('POST', '/login', { username: 'admin', pin: '2580' });
  const me = await call('GET', '/me', undefined, admin.cookie);
  assert.match(me.data.storageWarning, /No persistent disk/);
  assert.ok(me.data.dbCreatedAt);
  const picker = await call('POST', '/login', { username: 'srivers', pin: '2468' });
  const pme = await call('GET', '/me', undefined, picker.cookie);
  assert.equal(pme.data.storageWarning, undefined, 'only admins see it');
});
