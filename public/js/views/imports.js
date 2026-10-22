// Management: bring pick lists in from VIP instead of typing them. Nothing is saved until "Import".
import { api } from '../api.js';
import { esc, toast, fmtNum, UNIT_SHORT } from '../ui.js';

const view = document.getElementById('view');

export async function importView(ctx) {
  ctx.chrome('Import from VIP', '#/orders');
  let preview = null;
  let picked = new Set();

  function renderStart(message = '') {
    view.innerHTML = `
      <section class="card">
        <h2>Pick lists from VIP</h2>
        <p class="muted small">Choose the file VIP saved, or paste its text. You'll see every order before anything is created.</p>
        <label class="btn btn-primary file-btn">Choose file<input type="file" id="vipFile" accept=".txt,.csv,.tsv,.prn,.lst,text/plain,text/csv" hidden></label>
        <label>Or paste here<textarea id="vipText" rows="8" placeholder="Paste the IN005 PICK LIST text, or a CSV with Load, Stop, Store, Code, Description, Qty columns"></textarea></label>
        <button class="btn btn-ghost" data-act="read">Read pasted text</button>
        ${message ? `<p class="form-error">${esc(message)}</p>` : ''}
      </section>
      <p class="muted small">Works today with the IN005 pick list saved as text, and with CSV files. Once we have sample files from VIP, this will be matched to their exact format.</p>`;
    document.getElementById('vipFile').onchange = async (e) => {
      const file = e.target.files[0];
      if (file) read(await file.text(), file.name);
    };
  }

  async function read(text, filename = '') {
    try {
      preview = await api.post('/orders/import/preview', { text, filename });
      picked = new Set(preview.orders.map((o, i) => (o.duplicateOf ? null : i)).filter((i) => i !== null));
      renderPreview();
    } catch (err) { renderStart(err.message); }
  }

  function renderPreview() {
    const { orders, warnings } = preview;
    view.innerHTML = `
      ${warnings.length ? `<div class="banner warn"><b>Check these:</b><ul class="plain">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <p class="muted small">${orders.length} order${orders.length === 1 ? '' : 's'} found. Untick any you don't want.</p>
      ${orders.map((o, i) => `
        <section class="card import-order ${picked.has(i) ? '' : 'skipped'}">
          <label class="radio import-head"><input type="checkbox" data-i="${i}" ${picked.has(i) ? 'checked' : ''}>
            <span><b>${esc(o.store || 'No store name')}</b><br>
            <span class="muted small">${o.truck ? `Truck ${o.truck}` : `<b class="text-danger">Load #${esc(o.load_no || '?')} isn't a known truck</b>`} · Stop ${esc(o.stop || '—')} · ${o.lines.length} lines · ${fmtNum(o.cases)} cases</span></span></label>
          ${o.duplicateOf ? "<p class=\"small text-warn\">Already on today's trucks. Unticked so it isn't added twice.</p>" : ''}
          ${o.newItems.length ? `<p class="small text-warn">New item codes: ${o.newItems.map(esc).join(', ')}. They'll be added to the item list.</p>` : ''}
          <details><summary class="small">Show lines</summary>
            <ul class="plain small">${o.lines.map((l) => `<li>#${esc(l.code)} ${esc(l.description)} · ${l.qty} ${esc(UNIT_SHORT[l.unit] || l.unit)}${l.vipOut ? ' · <b class="text-danger">*OUT</b>' : ''}</li>`).join('')}</ul>
          </details>
        </section>`).join('')}
      <div class="bottom-bar">
        <button class="btn btn-ghost" data-act="restart">Start over</button>
        <button class="btn btn-primary btn-scan" data-act="import" ${picked.size ? '' : 'disabled'}>Import ${picked.size} order${picked.size === 1 ? '' : 's'}</button>
      </div>`;
    view.querySelectorAll('input[data-i]').forEach((box) => {
      box.onchange = () => { const i = Number(box.dataset.i); if (box.checked) picked.add(i); else picked.delete(i); renderPreview(); };
    });
  }

  ctx.actions.read = () => {
    const text = document.getElementById('vipText').value;
    if (!text.trim()) { renderStart('Paste the pick list text first.'); return; }
    read(text);
  };
  ctx.actions.restart = () => { preview = null; renderStart(); };
  ctx.actions.import = async () => {
    const orders = preview.orders.filter((_, i) => picked.has(i)).map((o) => ({ ...o, truck: o.truck || undefined }));
    try {
      const r = await api.post('/orders/import', { orders });
      toast(`${r.created} order${r.created === 1 ? '' : 's'} imported${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`, r.skipped.length ? '' : 'ok');
      if (r.skipped.length) {
        view.innerHTML = `<div class="banner warn"><b>Not imported:</b><ul class="plain">${r.skipped.map((s) => `<li>${esc(s.store || '?')} (Stop ${esc(s.stop || '?')}): ${esc(s.error)}</li>`).join('')}</ul></div>
          <a class="btn btn-primary" href="#/">Go to trucks</a>`;
      } else location.hash = '#/';
    } catch (err) { toast(err.message, 'error'); }
  };

  renderStart();
}
