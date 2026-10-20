// App shell: sign-in, routing, menu, and background refresh.
import { api } from './api.js';
import { esc, toast, choose, closeModal, modalOpen, ROLE_LABEL, COMPANY } from './ui.js';
import * as Scanner from './scanner.js';
import { trucksView, truckView } from './views/trucks.js';
import { pickView } from './views/pick.js';
import { reviewListView, reviewView } from './views/review.js';
import { ordersView, orderEditView } from './views/orders.js';
import { itemsView, barcodesView } from './views/items.js';
import { usersView } from './views/users.js';
import { reportsView } from './views/reports.js';
import { settingsView, accountView } from './views/settings.js';

const view = document.getElementById('view');
const topbar = document.getElementById('topbar');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('backBtn');
const menuDot = document.getElementById('menuDot');

const RANK = { picker: 0, supervisor: 1, management: 2, admin: 3 };

// Shared state handed to every view.
const ctx = {
  user: null,
  trucks: [],
  vapidKey: null,
  counts: { review: 0, pendingBarcodes: 0 },
  refresh: null,       // set by a view that wants live updates
  actions: {},         // click handlers for [data-act] buttons in the current view
  can: (role) => !!ctx.user && RANK[ctx.user.role] >= RANK[role],
  chrome(title, back) {
    titleEl.textContent = title;
    document.title = `${title} · Pick Sheets · ${COMPANY}`;
    backBtn.hidden = !back;
    backBtn.onclick = () => { location.hash = back; };
  },
  truckName: (n) => (n ? `Truck ${n}` : 'Unknown truck'),
  async reloadMe() {
    const me = await api.get('/me');
    Object.assign(ctx, { user: me.user, trucks: me.trucks, vapidKey: me.vapidKey });
    lastVersion = me.version;
  },
};

view.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !ctx.actions[el.dataset.act]) return;
  e.preventDefault();
  ctx.actions[el.dataset.act](el.dataset.arg, el, e);
});

// ---------- routing ----------
const routes = [
  [/^$/, trucksView],
  [/^truck\/(\w+)$/, truckView],
  [/^order\/(\d+)$/, pickView],
  [/^review$/, reviewListView, 'supervisor'],
  [/^review\/(\d+)$/, reviewView, 'supervisor'],
  [/^orders$/, ordersView, 'management'],
  [/^orders\/new$/, orderEditView, 'management'],
  [/^orders\/(\d+)\/edit$/, orderEditView, 'management'],
  [/^items$/, itemsView, 'management'],
  [/^barcodes$/, barcodesView, 'supervisor'],
  [/^reports$/, reportsView, 'management'],
  [/^users$/, usersView, 'admin'],
  [/^settings$/, settingsView, 'admin'],
  [/^account$/, accountView],
];

let routeSeq = 0;
async function route() {
  if (!ctx.user) return;
  if (Scanner.isOpen()) Scanner.close();
  closeModal();
  ctx.actions = {};
  ctx.refresh = null;
  const seq = ++routeSeq;
  const path = location.hash.replace(/^#\/?/, '');
  const match = routes.map(([re, fn, role]) => [path.match(re), fn, role]).find(([m]) => m);
  if (!match) { location.hash = '#/'; return; }
  const [m, fn, role] = match;
  if (role && !ctx.can(role)) { location.hash = '#/'; return; }
  view.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await fn(ctx, ...m.slice(1));
  } catch (err) {
    if (seq !== routeSeq) return;
    view.innerHTML = `<div class="empty"><p>${esc(err.message)}</p><a class="btn btn-ghost" href="#/">Back to trucks</a></div>`;
  }
  view.focus({ preventScroll: true });
}
window.addEventListener('hashchange', route);

// ---------- menu ----------
document.getElementById('menuBtn').onclick = async () => {
  const badge = (n) => (n ? ` <span class="badge">${n}</span>` : '');
  const items = [
    { key: '#/', label: 'Trucks' },
    ctx.can('supervisor') && { key: '#/review', html: `Outs to review${badge(ctx.counts.review)}` },
    ctx.can('supervisor') && { key: '#/barcodes', html: `Barcodes to check${badge(ctx.counts.pendingBarcodes)}` },
    ctx.can('management') && { key: '#/orders', label: 'Manage orders' },
    ctx.can('management') && { key: '#/items', label: 'Items & barcodes' },
    ctx.can('management') && { key: '#/reports', label: 'Reports' },
    ctx.can('admin') && { key: '#/users', label: 'Employees' },
    ctx.can('admin') && { key: '#/settings', label: 'Settings' },
    { key: '#/account', label: 'My account' },
    { key: 'logout', label: 'Sign out', danger: true },
  ].filter(Boolean);
  const pick = await choose('Menu', items, `${esc(ctx.user.name)} · ${ROLE_LABEL[ctx.user.role]}<br><span class="small">${COMPANY} · Proof of concept</span>`);
  if (pick === 'logout') signOut();
  else if (pick) { if (location.hash === pick || (pick === '#/' && !location.hash)) route(); else location.hash = pick; }
};

async function signOut() {
  await api.post('/logout').catch(() => {});
  ctx.user = null;
  showLogin();
}
window.addEventListener('signed-out', () => { if (ctx.user) { ctx.user = null; showLogin('Your session ended. Please sign in again.'); } });

// ---------- sign in ----------
function showLogin(message = '') {
  if (Scanner.isOpen()) Scanner.close();
  closeModal();
  topbar.hidden = true;
  view.innerHTML = `
    <form class="card login" id="loginForm">
      <img src="/icons/icon.svg" alt="" class="login-logo">
      <p class="company">${COMPANY}</p>
      <h2>Pick Sheets</h2>
      <p class="center"><span class="pill pill-poc">Proof of concept</span></p>
      <label>Username<input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>
      <label>PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="current-password" required></label>
      <p class="form-error" ${message ? '' : 'hidden'}>${esc(message)}</p>
      <button class="btn btn-primary btn-block">Sign in</button>
      <p class="muted small center">No account? Ask your administrator.</p>
      <p class="muted small center poc-note">${COMPANY} · Proof of concept, not for production use yet.</p>
    </form>`;
  const form = document.getElementById('loginForm');
  const err = form.querySelector('.form-error');
  form.elements.username.value = localStorage.getItem('lastUsername') || '';
  (form.elements.username.value ? form.elements.pin : form.elements.username).focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    try {
      await api.post('/login', { username: form.elements.username.value.trim(), pin: form.elements.pin.value });
      localStorage.setItem('lastUsername', form.elements.username.value.trim());
      await start();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      form.elements.pin.value = '';
    }
  };
}

// ---------- live updates ----------
let lastVersion = 0;
async function poll() {
  if (!ctx.user || document.hidden) return;
  try {
    const p = await api.get('/ping');
    ctx.counts = { review: p.review, pendingBarcodes: p.pendingBarcodes };
    menuDot.hidden = !(p.review || p.pendingBarcodes);
    const busy = modalOpen() || Scanner.isOpen() || document.activeElement?.matches('input, textarea, select');
    if (p.version !== lastVersion && ctx.refresh && !busy) {
      lastVersion = p.version;
      await ctx.refresh();
    } else if (!busy) {
      lastVersion = p.version;
    }
  } catch { /* offline: try again next tick */ }
}
setInterval(poll, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

async function start() {
  try {
    await ctx.reloadMe();
  } catch {
    showLogin();
    return;
  }
  topbar.hidden = false;
  route();
  poll();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Tapping a notification while the app is open navigates here.
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.url) location.href = e.data.url; });

start();
