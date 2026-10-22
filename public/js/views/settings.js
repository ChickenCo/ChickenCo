// Admin settings (trucks, demo data, backup) and every user's own account page.
import { api } from '../api.js';
import { esc, toast, ask, confirmBox, fmtTime, ROLE_LABEL } from '../ui.js';
import { upcSvg } from '../upc.js';
import { myRateHtml } from './rates.js';

const view = document.getElementById('view');

export async function settingsView(ctx) {
  ctx.chrome('Settings', '#/');
  let rows = ctx.trucks.map((t) => ({ ...t }));

  function render() {
    const srv = ctx.server || {};
    view.innerHTML = `
      ${srv.storageWarning ? `<div class="banner danger"><b>Data is not being saved.</b> ${esc(srv.storageWarning)}</div>` : ''}
      <section class="card">
        <h2>Trucks</h2>
        <p class="muted small">Which load # on the VIP pick list belongs to which truck.</p>
        <div id="truckRows">${rows.map((t, i) => `
          <div class="truck-row" data-i="${i}">
            <label>Truck<input name="truck" type="number" inputmode="numeric" value="${t.truck}"></label>
            <label>Load #<input name="load" inputmode="numeric" value="${esc(t.load)}"></label>
            <button class="btn btn-small btn-ghost btn-danger-text" data-act="delTruck" data-arg="${i}" aria-label="Remove truck">✕</button>
          </div>`).join('')}</div>
        <div class="toolbar">
          <button class="btn btn-ghost" data-act="addTruck">+ Add truck</button>
          <button class="btn btn-primary" data-act="saveTrucks">Save trucks</button>
        </div>
      </section>
      <section class="card" id="backupBox"><h2>Backups</h2><p class="muted small">Loading…</p></section>
      <section class="card">
        <h2>Test run</h2>
        <p class="muted small">Adds a fresh copy of the real Chuck's Carry Out pick list (Truck 1, Stop 008, 24 lines, 113 cases, 01172 printed *OUT) so anyone can practice picking it start to finish. Use <b>Print test barcodes</b> below to scan without real product.</p>
        <button class="btn btn-primary" data-act="testRun">Start Chuck's Carry Out test run</button>
      </section>
      <section class="card">
        <h2>Data</h2>
        <div class="toolbar">
          <button class="btn btn-ghost" data-act="demo">Load demo data</button>
          <button class="btn btn-ghost" data-act="labels">Print test barcodes</button>
        </div>
        <p class="muted small">Demo data adds the Chuck's Carry Out pick list and a few sample orders, plus three test logins:
          <b>picker</b> / 1111, <b>supervisor</b> / 2222, <b>manager</b> / 3333. The test barcodes only work with the demo items.</p>
        <p class="muted small">Database created ${fmtTime(srv.dbCreatedAt)} · server started ${fmtTime(srv.serverStartedAt)}.
          If the database keeps showing as created when the server started, data is being wiped on restart.</p>
      </section>`;
    loadBackups();
    view.querySelectorAll('.truck-row input').forEach((inp) => {
      inp.oninput = () => { const r = rows[Number(inp.closest('.truck-row').dataset.i)]; r[inp.name] = inp.name === 'truck' ? Number(inp.value) : inp.value.trim(); };
    });
  }

  ctx.actions.addTruck = () => { const n = Math.max(0, ...rows.map((r) => r.truck)) + 1; rows.push({ truck: n, load: String(200 + n) }); render(); };
  ctx.actions.delTruck = (i) => { rows.splice(Number(i), 1); render(); };
  ctx.actions.saveTrucks = async () => {
    try { ctx.trucks = await api.put('/settings/trucks', { trucks: rows }); rows = ctx.trucks.map((t) => ({ ...t })); render(); toast('Trucks saved', 'ok'); } catch (err) { toast(err.message, 'error'); }
  };
  ctx.actions.demo = async () => {
    if (!await confirmBox('Load demo data?', 'Sample orders, items and three test logins are added. Use this for trying things out, not on the real system.', 'Load')) return;
    try { const r = await api.post('/admin/demo'); toast(`Added ${r.orders} orders, ${r.items} items, ${r.users} logins`, 'ok'); } catch (err) { toast(err.message, 'error'); }
  };
  ctx.actions.testRun = async () => {
    try {
      const r = await api.post('/admin/test-run');
      toast("Chuck's Carry Out test run added to Truck 1", 'ok');
      location.hash = `#/order/${r.id}`;
    } catch (err) { toast(err.message, 'error'); }
  };
  ctx.actions.labels = async () => {
    const items = await api.get('/items');
    const labels = items.flatMap((i) => i.barcodes.filter((b) => b.display.startsWith('200000')).map((b) => ({ ...i, upc: b.display })));
    view.innerHTML = `
      <div class="toolbar no-print"><button class="btn btn-primary" data-act="print">Print</button>
        <button class="btn btn-ghost" data-act="back">Back</button></div>
      <p class="muted small no-print">${labels.length ? 'Scan these from a phone to try picking without real product.' : 'Load the demo data first.'}</p>
      <div class="labels">${labels.map((l) => `<div class="label">${upcSvg(l.upc)}<strong>#${esc(l.code)}</strong><span>${esc(l.description)}</span></div>`).join('')}</div>`;
  };
  ctx.actions.back = render;

  async function loadBackups() {
    const box = document.getElementById('backupBox');
    if (!box) return;
    const b = await api.get('/admin/backups').catch(() => null);
    if (!b) return;
    box.innerHTML = `
      <h2>Backups</h2>
      <p class="small">${b.at ? `Last backup <b>${fmtTime(b.at)}</b> (${esc(b.reason)})${b.error ? ` · <b class="text-danger">failed: ${esc(b.error)}</b>` : ''}` : 'No backup yet. The first one runs a minute after the server starts.'}</p>
      <ul class="plain small">
        <li>On the server's disk: ${b.local ? '✓ saved' : '—'} (the newest ${b.keep} are kept)</li>
        <li>Outside storage: ${b.offsiteConfigured ? (b.offsite === 'uploaded' ? '✓ uploaded' : esc(b.offsite || 'waiting')) : '<b class="text-warn">not set up</b>'}</li>
      </ul>
      <p class="muted small">Backups run every night and whenever all trucks are loaded.${b.offsiteConfigured ? '' : ' To also keep copies outside Render (recommended), add the BACKUP_S3_ settings described in the README.'}</p>
      <div class="toolbar"><button class="btn btn-ghost" data-act="backupNow">Back up now</button>
        <a class="btn btn-ghost" href="/api/admin/backup" download>Download a copy</a></div>`;
  }
  ctx.actions.backupNow = async () => {
    toast('Backing up…');
    try { const s = await api.post('/admin/backups'); toast(s.error ? `Backup failed: ${s.error}` : 'Backup saved', s.error ? 'error' : 'ok'); } catch (err) { toast(err.message, 'error'); }
    loadBackups();
  };
  ctx.actions.print = () => window.print();

  render();
}

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export async function accountView(ctx) {
  ctx.chrome('My account', '#/');

  async function pushState() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : Notification.permission === 'denied' ? 'denied' : 'off';
  }

  async function render() {
    const [state, rate] = await Promise.all([pushState().catch(() => 'unsupported'), myRateHtml(ctx).catch(() => '')]);
    const why = ctx.can('management')
      ? 'Get a notification when a picker marks something out, and when all trucks are loaded.'
      : ctx.can('supervisor')
      ? 'Get a notification when a picker marks something out.'
      : 'Get a notification when a supervisor sends an item back to you or assigns you an order.';
    view.innerHTML = `
      <section class="card">
        <h2>${esc(ctx.user.name)}</h2>
        <p class="muted">Username <b>${esc(ctx.user.username)}</b> · ${ROLE_LABEL[ctx.user.role]}</p>
        <button class="btn btn-ghost" data-act="pin">Change my PIN</button>
      </section>
      ${rate}
      <section class="card">
        <h2>Notifications</h2>
        <p class="muted small">${why}</p>
        ${state === 'on' ? '<p class="text-ok"><b>✓ Notifications are on for this phone.</b></p><button class="btn btn-ghost" data-act="pushOff">Turn off</button>'
          : state === 'denied' ? '<p class="text-warn">Notifications are blocked. On iPhone: Settings › Notifications › Pick Sheets › Allow Notifications.</p>'
          : state === 'unsupported' || (isIOS() && !isStandalone()) ? `
            <div class="steps">
              <p><b>On iPhone, first add this app to your Home Screen:</b></p>
              <ol><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (square with an arrow).</li><li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open <b>Pick Sheets</b> from your Home Screen and come back to this page.</li></ol>
            </div>`
          : '<button class="btn btn-primary" data-act="pushOn">Turn on notifications</button>'}
      </section>`;
  }

  ctx.actions.pin = async () => {
    const ok = await ask({
      title: 'Change my PIN',
      okText: 'Save',
      body: `<label>Current PIN<input name="current" type="password" inputmode="numeric" autocomplete="current-password"></label>
             <label>New PIN<input name="a" type="password" inputmode="numeric" autocomplete="new-password" placeholder="4 to 8 digits"></label>
             <label>New PIN again<input name="b" type="password" inputmode="numeric" autocomplete="new-password"></label>`,
      onOk: async (f) => {
        if (f.elements.a.value !== f.elements.b.value) throw new Error('The new PINs do not match');
        await api.post('/me/pin', { current: f.elements.current.value, pin: f.elements.a.value });
        return true;
      },
    });
    if (ok) toast('PIN changed', 'ok');
  };
  ctx.actions.pushOn = async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { render(); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(ctx.vapidKey) });
      await api.post('/push/subscribe', sub.toJSON());
      toast('Notifications on', 'ok');
    } catch (err) { toast(`Could not turn on notifications: ${err.message}`, 'error'); }
    render();
  };
  ctx.actions.pushOff = async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
    render();
  };

  await render();
}
