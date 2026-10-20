// Items (product codes) and the UPC barcodes linked to them.
import { api, qs } from '../api.js';
import * as Scanner from '../scanner.js';
import { esc, toast, ask, confirmBox, feedback, fmtTime } from '../ui.js';

const view = document.getElementById('view');

export async function itemsView(ctx) {
  ctx.chrome('Items & barcodes', '#/');
  let items = [];
  let filter = '';
  view.innerHTML = `
    <div class="toolbar">
      <button class="btn btn-primary" data-act="add">+ Add item</button>
      <button class="btn btn-ghost" data-act="import">Import list</button>
    </div>
    <input class="search" type="search" placeholder="Search code or description" id="itemSearch">
    <p class="muted small" id="itemCount"></p>
    <ul class="lines" id="itemList"></ul>`;

  const list = document.getElementById('itemList');
  const draw = () => {
    const shown = items.filter((i) => !filter || `${i.code} ${i.description}`.toLowerCase().includes(filter));
    const noBarcode = items.filter((i) => !i.barcodes.length).length;
    document.getElementById('itemCount').textContent = `${items.length} items${noBarcode ? ` · ${noBarcode} without a barcode` : ''}`;
    list.innerHTML = shown.slice(0, 300).map((i) => `
      <li class="line" data-act="edit" data-arg="${esc(i.code)}">
        <span class="line-main">
          <span class="line-name">${esc(i.description)}</span>
          <span class="muted small">#${esc(i.code)} · ${i.barcodes.length ? `${i.barcodes.length} barcode${i.barcodes.length === 1 ? '' : 's'}` : '<b class="text-warn">no barcode</b>'}${i.barcodes.some((b) => b.status === 'pending') ? ' · <b class="text-warn">unchecked</b>' : ''}</span>
        </span>
        <span class="chev">›</span>
      </li>`).join('') || `<li class="empty muted">${filter ? 'No matching items.' : 'No items yet.'}</li>`;
  };
  const load = async () => { items = await api.get('/items'); draw(); };
  document.getElementById('itemSearch').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); draw(); };

  ctx.actions.add = async () => {
    const saved = await itemForm({});
    if (saved) { await load(); editItem(saved.code); }
  };
  ctx.actions.edit = (code) => editItem(code);
  ctx.actions.import = async () => {
    const res = await ask({
      title: 'Import items',
      okText: 'Import',
      body: `<p class="muted small">Paste one item per line: <code>code, description, barcode</code>. The barcode is optional, and you can list more than one. Copying straight from a spreadsheet works. Existing codes get updated.</p>
        <textarea name="text" rows="9" placeholder="00439, MULTRA 24/12 CAN, 018200007118"></textarea>`,
      onOk: async (f) => {
        if (!f.elements.text.value.trim()) throw new Error('Paste at least one line');
        return api.post('/items/import', { text: f.elements.text.value });
      },
    });
    if (res) { toast(`${res.added} added, ${res.updated} updated, ${res.barcodes} barcodes${res.skipped ? `, ${res.skipped} skipped` : ''}`, 'ok'); load(); }
  };

  async function itemForm(it) {
    return ask({
      title: it.code ? 'Edit item' : 'Add item',
      okText: 'Save',
      body: `
        <label>Item code<input name="code" value="${esc(it.code)}" inputmode="numeric" autocomplete="off" placeholder="00439"></label>
        <label>Description<input name="description" value="${esc(it.description)}" autocomplete="off" autocapitalize="characters" placeholder="MULTRA 24/12 CAN"></label>`,
      onOk: (f) => api.post('/items', { code: f.elements.code.value, description: f.elements.description.value, originalCode: it.code }),
    });
  }

  async function editItem(code) {
    const it = items.find((i) => i.code === code);
    if (!it) return;
    const result = await ask({
      title: it.description,
      okText: '',
      cancelText: 'Close',
      body: `
        <p class="muted">Item #${esc(it.code)}</p>
        <h3 class="small-title">Barcodes</h3>
        <ul class="barcode-list">${it.barcodes.map((b) => `
          <li><span class="mono">${esc(b.display)}</span>${b.status === 'pending' ? ' <span class="pill pill-warn">unchecked</span>' : ''}
          <button type="button" class="btn btn-small btn-ghost btn-danger-text" data-rm="${esc(b.gtin)}">Remove</button></li>`).join('') || '<li class="muted">None yet. Scan the case barcode to add one.</li>'}
        </ul>
        <button type="button" class="btn btn-primary btn-block" data-do="scan">Scan a barcode to add</button>
        <button type="button" class="btn btn-ghost btn-block" data-do="type">Type a barcode</button>
        <button type="button" class="btn btn-ghost btn-block" data-do="edit">Edit code / description</button>
        <button type="button" class="btn btn-ghost btn-danger-text btn-block" data-do="delete">Delete item</button>`,
      onOpen: (form, finish) => {
        form.querySelectorAll('[data-do]').forEach((b) => { b.onclick = () => finish(b.dataset.do); });
        form.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => finish(`rm:${b.dataset.rm}`); });
      },
    });
    if (!result) return;
    try {
      if (result === 'scan') {
        Scanner.open(async (text, format) => {
          try {
            const r = await link(text, format);
            if (!r) return;
            feedback('ok');
            Scanner.setStatus(`✓ ${r.display} added`, 'ok');
            setTimeout(() => Scanner.close(), 700);
            await load();
            setTimeout(() => editItem(it.code), 750);
          } catch (err) { feedback('error'); Scanner.setStatus(err.message, 'error'); }
        }, async () => {
          const raw = await askBarcode();
          if (raw) { Scanner.close(); await addTyped(raw); }
        });
        return;
      }
      if (result === 'type') {
        const raw = await askBarcode();
        if (raw) await addTyped(raw);
        return;
      }
      if (result === 'edit') {
        const saved = await itemForm(it);
        if (saved) { await load(); editItem(saved.code); }
        return;
      }
      if (result === 'delete') {
        if (await confirmBox('Delete item?', `${it.description} (#${it.code}) and its barcodes will be removed. Existing orders keep their lines.`, 'Delete', true)) {
          await api.del(`/items/${encodeURIComponent(it.code)}`);
          toast('Item deleted');
          await load();
        }
        return;
      }
      if (result.startsWith('rm:')) {
        await api.del(`/barcodes/${encodeURIComponent(result.slice(3))}`);
        await load();
        editItem(it.code);
      }
    } catch (err) { toast(err.message, 'error'); }

    // Warn before moving a barcode that already belongs to a different item.
    async function link(raw, format) {
      const f = await api.get(`/barcodes/lookup${qs({ raw, format })}`);
      if (f.item && f.item.code !== it.code
        && !await confirmBox('Barcode already used', `${f.display} is linked to ${f.item.description} (#${f.item.code}). Move it to this item?`, 'Move it')) return null;
      return api.post('/barcodes', { raw, format, code: it.code });
    }

    async function addTyped(raw) {
      try {
        const r = await link(raw, '');
        if (r) toast(`${r.display} added`, 'ok');
      } catch (err) { toast(err.message, 'error'); }
      await load();
      editItem(it.code);
    }
  }

  ctx.refresh = load;
  await load();
}

function askBarcode() {
  return ask({
    title: 'Type a barcode',
    okText: 'Add',
    body: '<label>Numbers under the barcode<input name="raw" inputmode="numeric" autocomplete="off"></label>',
    onOk: (f) => { const v = f.elements.raw.value.replace(/\s/g, ''); if (!v) throw new Error('Enter the barcode number'); return v; },
  });
}

// Supervisor: barcodes pickers linked during picking, waiting for a check.
export async function barcodesView(ctx) {
  ctx.chrome('Barcodes to check', '#/');
  const render = async () => {
    const rows = await api.get('/barcodes/pending');
    view.innerHTML = `
      <p class="muted small">Pickers linked these barcodes to items when the app didn't recognize them. Make sure each barcode is really on that product.</p>
      ${rows.map((b) => `
        <div class="card">
          <strong>${esc(b.description)}</strong>
          <div class="muted small">#${esc(b.code)} · barcode <span class="mono">${esc(b.display)}</span></div>
          <div class="muted small">Linked by ${esc(b.added_by_name || '—')} · ${fmtTime(b.created_at)}</div>
          <div class="btn-row">
            <button class="btn btn-primary" data-act="ok" data-arg="${esc(b.gtin)}">Correct</button>
            <button class="btn btn-ghost btn-danger-text" data-act="no" data-arg="${esc(b.gtin)}">Wrong – remove</button>
          </div>
        </div>`).join('') || '<div class="empty muted">Nothing to check.</div>'}`;
  };
  ctx.actions.ok = async (gtin) => { try { await api.post(`/barcodes/${gtin}/confirm`); render(); } catch (err) { toast(err.message, 'error'); } };
  ctx.actions.no = async (gtin) => {
    if (!await confirmBox('Remove barcode?', 'The link is removed. Next time this barcode is scanned the picker will be asked again.', 'Remove', true)) return;
    try { await api.del(`/barcodes/${gtin}`); render(); } catch (err) { toast(err.message, 'error'); }
  };
  ctx.refresh = render;
  await render();
}
