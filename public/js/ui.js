// Shared UI helpers: escaping, toasts, modals, quantity prompts, beeps.
const modal = document.getElementById('modal');
const modalForm = document.getElementById('modalForm');
const toastEl = document.getElementById('toast');

export const COMPANY = 'Perry Distributors Inc.';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const UNIT_SHORT = { CASES: 'cs', BTLS: 'btl', KEGS: 'keg', MISC: 'misc' };
export const OUT_REASONS = { vip: 'Out on VIP sheet', out_of_stock: 'Out of stock', cant_find: "Can't find" };
export const STATUS = {
  open: ['Not started', ''],
  picking: ['Picking', 'pill-warn'],
  review: ['Needs review', 'pill-danger'],
  done: ['Done', 'pill-ok'],
};
export const ROLE_LABEL = { driver: 'Driver', picker: 'Picker', supervisor: 'Supervisor', management: 'Management', admin: 'Admin' };

export const statusPill = (s) => `<span class="pill ${STATUS[s][1]}">${STATUS[s][0]}</span>`;

export function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "134 cases/hr", in red when under the target. No rate yet when there's under 5 minutes of picking.
export function rateHtml(rate, target, { big = false } = {}) {
  if (rate == null) return '<span class="muted">not enough picking yet</span>';
  return `<span class="rate ${big ? 'rate-big' : ''} ${rate < target ? 'rate-low' : ''}">${rate.toLocaleString()}<small> cases/hr</small></span>`;
}

export function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const fmtNum = (n) => Number(n || 0).toLocaleString();

export const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

let toastTimer;
export function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 2800);
}

let audio;
export function feedback(kind) {
  if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 60 : [120, 80, 120]);
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = kind === 'ok' ? 1046 : 220;
    gain.gain.value = 0.2;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (kind === 'ok' ? 0.12 : 0.4));
  } catch { /* sound is optional */ }
}

export const modalOpen = () => modal.open;
export function closeModal() { if (modal.open) modal.close(); }

// Generic modal. `onOk(form)` returns the result (may be async) or throws to show an error.
export function ask({ title, body = '', okText = 'OK', cancelText = 'Cancel', danger = false, onOk = () => true, onOpen, wide = false }) {
  return new Promise((resolve) => {
    modal.classList.toggle('wide', wide);
    modalForm.innerHTML = `
      <h2>${esc(title)}</h2>
      <div class="modal-body">${body}</div>
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        ${cancelText ? `<button type="button" class="btn btn-ghost" data-cancel>${esc(cancelText)}</button>` : ''}
        ${okText ? `<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(okText)}</button>` : ''}
      </div>`;
    const errEl = modalForm.querySelector('.form-error');
    let busy = false;
    const finish = (val) => {
      modalForm.onsubmit = null;
      modal.oncancel = null;
      modal.onclose = null;
      if (modal.open) modal.close();
      resolve(val);
    };
    modalForm.onsubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      try { finish(await onOk(modalForm, e.submitter)); } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
      busy = false;
    };
    modal.oncancel = (e) => { e.preventDefault(); finish(null); };
    // Closed by navigation. The close event fires async, so a stale one from the previous
    // modal can arrive after this one opened; ignore it while the dialog is open.
    modal.onclose = () => { if (!modal.open) finish(null); };
    const cancel = modalForm.querySelector('[data-cancel]');
    if (cancel) cancel.onclick = () => finish(null);
    modal.showModal();
    if (onOpen) onOpen(modalForm, finish);
    const first = modalForm.querySelector('[autofocus]') || modalForm.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea');
    if (first) { first.focus(); if (first.select) first.select(); }
  });
}

export const confirmBox = (title, text, okText = 'Yes', danger = false) =>
  ask({ title, body: `<p>${esc(text)}</p>`, okText, danger });

// A list of big buttons; resolves with the chosen key (or null).
export function choose(title, options, subtitle = '') {
  return ask({
    title,
    okText: '',
    body: `${subtitle ? `<p class="muted">${subtitle}</p>` : ''}<div class="choice-list">${options.map((o) =>
      `<button type="button" class="btn btn-block ${o.danger ? 'btn-danger-text' : 'btn-ghost'} ${o.primary ? 'btn-primary' : ''}" data-choice="${esc(o.key)}">${o.html ?? esc(o.label)}</button>`).join('')}</div>`,
    onOpen: (form, finish) => form.querySelectorAll('[data-choice]').forEach((b) => { b.onclick = () => finish(b.dataset.choice); }),
  });
}

// Quantity prompt with large +/- buttons for gloved hands.
// `read(form, n)` lets callers return extra fields from `extra` markup along with the number.
export function askQty({ title, subtitle = '', value = 1, min = 0, max = 9999, okText = 'Confirm', extra = '', read }) {
  return ask({
    title,
    okText,
    body: `
      ${subtitle ? `<p class="muted">${subtitle}</p>` : ''}
      <div class="qty-stepper">
        <button type="button" class="btn step" data-step="-1" aria-label="Less">&minus;</button>
        <input name="qty" type="number" inputmode="numeric" pattern="[0-9]*" min="${min}" max="${max}" value="${value}">
        <button type="button" class="btn step" data-step="1" aria-label="More">+</button>
      </div>
      ${max < 9999 && max > 1 ? `<button type="button" class="btn btn-ghost btn-block" data-all>All (${max})</button>` : ''}
      ${extra}`,
    onOpen(form) {
      const input = form.elements.qty;
      form.querySelectorAll('[data-step]').forEach((b) => {
        b.onclick = () => { input.value = Math.max(min, Math.min(max, (parseInt(input.value, 10) || 0) + Number(b.dataset.step))); };
      });
      const all = form.querySelector('[data-all]');
      if (all) all.onclick = () => { input.value = max; };
    },
    onOk(form) {
      const n = parseInt(form.elements.qty.value, 10);
      if (Number.isNaN(n) || n < min) throw new Error(`Enter a number of at least ${min}`);
      if (n > max) throw new Error(`The most you can enter is ${max}`);
      return read ? read(form, n) : n;
    },
  });
}

export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
