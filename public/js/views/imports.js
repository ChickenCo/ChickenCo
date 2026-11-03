// Management: bring orders in from VIP instead of typing them. Nothing is saved until "Import".
import { api } from '../api.js';
import { esc, toast, fmtNum, UNIT_SHORT } from '../ui.js';

const view = document.getElementById('view');

const SKIP_LABEL = {
  otherWarehouses: 'lines for other warehouses',
  returnsAndCredits: 'returns, credits and price corrections',
  tax: 'tax / service charge lines',
  voided: 'voided lines',
  empties: 'empties and credits',
};

// Delivery date for trucks loaded today, as MM/DD/YY (VIP's invoice date).
function nextDeliveryDate(now = new Date()) {
  const d = new Date(now);
  const add = { 5: 3, 6: 2, 0: 1 }[d.getDay()] ?? 1; // Fri→Mon, Sat→Mon, Sun→Mon, else tomorrow
  d.setDate(d.getDate() + add);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`;
}
const dueLabel = (now = new Date()) => ([5, 6, 0].includes(now.getDay()) ? 'Monday' : 'tomorrow');

export async function importView(ctx) {
  ctx.chrome('Import from VIP', '#/orders');
  let preview = null;
  let picked = new Set();
  let dayFilter = null;
  let dueMissing = null;

  function renderStart(message = '') {
    view.innerHTML = `
      <section class="card">
        <h2>Orders from VIP</h2>
        <p class="muted small">Choose the <b>order record</b> export from VIP (the Excel file, .xlsx). Only our warehouse's loads are used
          (middle digit ${esc(ctx.warehouseDigit ?? '0')}, e.g. 101–106 and 201–206). You'll see every order before anything is created.</p>
        <label class="btn btn-primary file-btn">Choose VIP file<input type="file" id="vipFile" accept=".xlsx,.csv,.txt,.tsv,.prn,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain" hidden></label>
        <p class="muted small" id="readingNote" hidden>Reading the file…</p>
        ${message ? `<p class="form-error">${esc(message)}</p>` : ''}
        <details><summary class="small">Paste text instead</summary>
          <label>IN005 pick list text or CSV<textarea id="vipText" rows="6"></textarea></label>
          <button class="btn btn-ghost" data-act="read">Read pasted text</button>
        </details>
      </section>`;
    document.getElementById('vipFile').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      document.getElementById('readingNote').hidden = false;
      try { show(await api.upload('/orders/import/preview', file)); } catch (err) { renderStart(err.message); }
    };
  }

  function show(p) {
    preview = p;
    // Trucks loaded today are due tomorrow; on Friday (and the weekend) they're due Monday.
    // Default to that delivery day if it's in the file, otherwise the latest day in it.
    const due = nextDeliveryDate();
    const match = p.days?.find((d) => d.date === due);
    dayFilter = match ? match.day_no : p.days?.length ? p.days.at(-1).day_no : null;
    dueMissing = p.days?.length && !match ? due : null;
    selectDay();
    renderPreview();
  }

  function selectDay() {
    picked = new Set(preview.orders.map((o, i) => (!o.duplicateOf && (!dayFilter || o.day_no === dayFilter) ? i : null)).filter((i) => i !== null));
  }

  function renderPreview() {
    const { orders, warnings, days, skipped, barcodes } = preview;
    const shown = orders.map((o, i) => ({ o, i })).filter(({ o }) => !dayFilter || o.day_no === dayFilter);
    const byTruck = new Map();
    shown.forEach((x) => { const k = x.o.truck ?? '?'; if (!byTruck.has(k)) byTruck.set(k, []); byTruck.get(k).push(x); });
    const selCases = [...picked].reduce((s, i) => s + orders[i].cases, 0);
    const skippedTotal = skipped ? Object.values(skipped).reduce((a, b) => a + b, 0) : 0;
    view.innerHTML = `
      ${warnings.length ? `<div class="banner warn"><ul class="plain">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      ${days?.length > 1 ? `<section class="card"><h2>Which delivery day?</h2>
        <div class="day-pick">${days.map((d) => `
          <button class="btn ${dayFilter === d.day_no ? 'btn-primary' : 'btn-ghost'}" data-act="day" data-arg="${d.day_no}">
            <b>${esc(d.dayName || `Day ${d.day_no}`)} ${esc(d.date)}</b><span class="small">Loads ${esc(d.loads[0])}–${esc(d.loads.at(-1))} · ${d.orders} orders · ${fmtNum(d.cases)} cs</span>
          </button>`).join('')}</div>
        <p class="muted small">Trucks loaded today are due ${esc(dueLabel())}. Import one delivery day at a time.</p>
        ${dueMissing ? `<p class="small text-warn">This file has no orders due ${esc(dueLabel())} (${esc(dueMissing)}). Check that it's the latest export from VIP.</p>` : ''}
      </section>` : ''}
      ${dueMissing && !(days?.length > 1) ? `<div class="banner warn">This file has no orders due ${esc(dueLabel())} (${esc(dueMissing)}). Check that it's the latest export from VIP.</div>` : ''}
      <p class="muted small">${shown.length} order${shown.length === 1 ? '' : 's'}${skippedTotal ? ` · left out: ${Object.entries(skipped).filter(([, n]) => n).map(([k, n]) => `${fmtNum(n)} ${SKIP_LABEL[k] || k}`).join(', ')}` : ''}.
        ${barcodes?.total ? `<br>${fmtNum(barcodes.new)} new barcode${barcodes.new === 1 ? '' : 's'} from the UPC column will be added${barcodes.conflicts ? ` (${barcodes.conflicts} skipped: already linked to a different item)` : ''}.` : ''}</p>
      ${[...byTruck.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true })).map(([truck, list]) => `
        <h2 class="section-title">${truck === '?' ? 'Unknown truck' : `Truck ${truck}`} · ${list.length} order${list.length === 1 ? '' : 's'}</h2>
        ${list.map(({ o, i }) => `
          <section class="card import-order ${picked.has(i) ? '' : 'skipped'}">
            <label class="radio import-head"><input type="checkbox" data-i="${i}" ${picked.has(i) ? 'checked' : ''}>
              <span><b>Stop ${esc(o.stop || '—')} · ${esc(o.store || 'No store name')}</b><br>
              <span class="muted small">Load #${esc(o.load_no)}${o.account_no ? ` · Acct ${esc(o.account_no)}` : ''} · ${o.lines.length} lines · ${fmtNum(o.cases)} cases${o.invoices?.length ? ` · Inv ${o.invoices.map(esc).join(', ')}` : ''}</span></span></label>
            ${o.duplicateOf ? "<p class=\"small text-warn\">Already imported. Unticked so it isn't added twice.</p>" : ''}
            ${o.truck ? '' : `<p class="small text-danger">Load #${esc(o.load_no)} isn't one of our trucks.</p>`}
            ${o.notes?.length ? `<p class="small">📝 ${o.notes.map(esc).join(' · ')}</p>` : ''}
            ${o.lines.some((l) => l.vipOut) ? `<p class="small text-danger">VIP couldn't pick: ${o.lines.filter((l) => l.vipOut).map((l) => esc(l.description)).join(', ')} (comes in marked *OUT)</p>` : ''}
            <details><summary class="small">Show lines</summary>
              <ul class="plain small">${o.lines.map((l) => `<li>#${esc(l.code)} ${esc(l.description)} · ${l.qty} ${esc(UNIT_SHORT[l.unit] || l.unit)}${l.vipOut ? ' · <b class="text-danger">*OUT</b>' : ''}</li>`).join('')}</ul>
            </details>
          </section>`).join('')}`).join('')}
      <div class="bottom-bar">
        <button class="btn btn-ghost" data-act="restart">Start over</button>
        <button class="btn btn-primary btn-scan" data-act="import" ${picked.size ? '' : 'disabled'}>Import ${picked.size} order${picked.size === 1 ? '' : 's'} · ${fmtNum(selCases)} cs</button>
      </div>`;
    view.querySelectorAll('input[data-i]').forEach((box) => {
      box.onchange = () => { const i = Number(box.dataset.i); if (box.checked) picked.add(i); else picked.delete(i); renderPreview(); };
    });
  }

  ctx.actions.day = (d) => { dayFilter = d; selectDay(); renderPreview(); window.scrollTo(0, 0); };
  ctx.actions.read = async () => {
    const text = document.getElementById('vipText').value;
    if (!text.trim()) { renderStart('Paste the text first.'); return; }
    try { show(await api.post('/orders/import/preview', { text })); } catch (err) { renderStart(err.message); }
  };
  ctx.actions.restart = () => { preview = null; renderStart(); };
  ctx.actions.import = async () => {
    const orders = preview.orders.filter((_, i) => picked.has(i));
    const btn = view.querySelector('[data-act=import]');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const r = await api.post('/orders/import', { orders, barcodes: preview.barcodes?.list || [] });
      toast(`${r.created} order${r.created === 1 ? '' : 's'} imported${r.barcodesAdded ? `, ${r.barcodesAdded} barcodes added` : ''}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`, r.skipped.length ? '' : 'ok');
      if (r.skipped.length) {
        view.innerHTML = `<div class="banner warn"><b>Not imported:</b><ul class="plain">${r.skipped.map((s) => `<li>${esc(s.store || '?')} (Stop ${esc(s.stop || '?')}): ${esc(s.error)}</li>`).join('')}</ul></div>
          <a class="btn btn-primary" href="#/">Go to trucks</a>`;
      } else location.hash = '#/';
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  };

  renderStart();
}
