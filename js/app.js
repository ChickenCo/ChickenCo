// UI: hash-routed views for pickers and administrators.
(() => {
  const view = document.getElementById('view');
  const titleEl = document.getElementById('title');
  const backBtn = document.getElementById('backBtn');
  const adminLink = document.getElementById('adminLink');
  const modal = document.getElementById('modal');
  const modalForm = document.getElementById('modalForm');
  const toastEl = document.getElementById('toast');

  // Each view registers its click handlers here; buttons use data-act / data-arg.
  let actions = {};
  let backHref = null;
  let orderDraft = null;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const itemName = (sku) => (Store.item(sku) || {}).name || 'Unknown item';
  const itemLoc = (sku) => (Store.item(sku) || {}).location || '';
  const isAdmin = () => sessionStorage.getItem('chickenco.admin') === '1';

  function qrSvg(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }

  let toastTimer;
  function toast(msg, kind = '') {
    toastEl.textContent = msg;
    toastEl.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 2600);
  }

  let audio;
  function feedback(kind) {
    if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 60 : [120, 80, 120]);
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = kind === 'ok' ? 880 : 220;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + (kind === 'ok' ? 0.12 : 0.35));
    } catch { /* audio is optional */ }
  }

  function setChrome(title, back) {
    titleEl.textContent = title;
    document.title = `${title} · ChickenCo`;
    backHref = back || null;
    backBtn.hidden = !back;
    adminLink.hidden = location.hash.startsWith('#/admin');
  }

  // Generic modal. `fields` is inner HTML; `onOk(form)` returns the result or throws to show an error.
  function ask({ title, body = '', okText = 'OK', cancelText = 'Cancel', danger = false, onOk = () => true, onOpen }) {
    return new Promise((resolve) => {
      modalForm.innerHTML = `
        <h2>${esc(title)}</h2>
        <div class="modal-body">${body}</div>
        <p class="form-error" hidden></p>
        <div class="modal-actions">
          ${cancelText ? `<button type="button" class="btn btn-ghost" data-cancel>${esc(cancelText)}</button>` : ''}
          <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(okText)}</button>
        </div>`;
      const errEl = modalForm.querySelector('.form-error');
      const finish = (val) => {
        modalForm.onsubmit = null;
        modal.oncancel = null;
        modal.close();
        resolve(val);
      };
      modalForm.onsubmit = (e) => {
        e.preventDefault();
        try { finish(onOk(modalForm)); } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
      };
      modal.oncancel = (e) => { e.preventDefault(); finish(null); };
      const cancel = modalForm.querySelector('[data-cancel]');
      if (cancel) cancel.onclick = () => finish(null);
      modal.showModal();
      if (onOpen) onOpen(modalForm);
      const first = modalForm.querySelector('input:not([type=hidden]), select, textarea');
      if (first) { first.focus(); if (first.select) first.select(); }
    });
  }

  const confirmBox = (title, text, okText = 'Yes', danger = false) =>
    ask({ title, body: `<p>${esc(text)}</p>`, okText, danger });

  // Quantity prompt with large +/- buttons for gloved hands.
  function askQty({ title, subtitle = '', value = 1, min = 0, max = 9999, okText = 'Confirm' }) {
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
        ${max < 9999 ? `<button type="button" class="btn btn-ghost btn-block" data-all>All (${max})</button>` : ''}`,
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
        if (n > max) throw new Error(`Only ${max} needed`);
        return n;
      },
    });
  }

  function askSku(title = 'Enter SKU') {
    return ask({
      title,
      okText: 'Find',
      body: `<label>SKU<input name="sku" autocomplete="off" autocapitalize="characters" list="skuList"></label>${skuDatalist()}`,
      onOk(form) {
        const v = form.elements.sku.value.trim();
        if (!v) throw new Error('Enter a SKU');
        return v.split(' — ')[0];
      },
    });
  }

  const skuDatalist = () =>
    `<datalist id="skuList">${Store.items().map((i) => `<option value="${esc(i.sku)}">${esc(i.name)}</option>`).join('')}</datalist>`;

  // QR codes on labels hold the bare SKU; tolerate a "SKU:" prefix from other label printers.
  const skuFromScan = (text) => Store.normSku(String(text).replace(/^\s*sku\s*[:=]\s*/i, ''));

  // ---------- routing ----------
  function route() {
    if (Scanner.isOpen) Scanner.close();
    if (modal.open) modal.close();
    actions = {};
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'order' && parts[1]) return pickView(parts[1]);
    if (parts[0] === 'admin') {
      if (!isAdmin()) return adminLogin();
      if (parts[1] === 'order') return orderEditor(parts[2]);
      if (parts[1] === 'labels') return labelsView();
      return adminView(parts[1] || 'items');
    }
    return homeView();
  }

  view.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !actions[el.dataset.act]) return;
    e.preventDefault();
    actions[el.dataset.act](el.dataset.arg, el, e);
  });
  backBtn.onclick = () => { if (backHref) location.hash = backHref; };
  window.addEventListener('hashchange', route);

  // ---------- picker: home ----------
  function orderCard(o) {
    const p = Store.progress(o);
    const pct = p.need ? Math.round((p.got / p.need) * 100) : 0;
    return `
      <a class="card order-card ${o.status}" href="#/order/${o.id}">
        <div class="row">
          <strong>${esc(o.number)}</strong>
          <span class="pill ${o.status === 'complete' ? 'pill-ok' : p.got ? 'pill-warn' : ''}">
            ${o.status === 'complete' ? 'Complete' : p.got ? 'In progress' : 'Not started'}</span>
        </div>
        ${o.customer ? `<div class="muted">${esc(o.customer)}</div>` : ''}
        <div class="progress"><span style="width:${pct}%"></span></div>
        <div class="muted small">${p.linesDone}/${p.lines} lines · ${p.got}/${p.need} units</div>
      </a>`;
  }

  function homeView() {
    setChrome('Pick Sheets');
    const all = Store.orders();
    const open = all.filter((o) => o.status !== 'complete');
    const done = all.filter((o) => o.status === 'complete');
    if (!all.length) {
      view.innerHTML = `
        <div class="empty">
          <p><strong>No pick sheets yet.</strong></p>
          <p class="muted">An administrator adds items and creates pick sheets in <a href="#/admin">Admin</a>.</p>
          <button class="btn btn-primary" data-act="demo">Load demo data</button>
        </div>`;
      actions.demo = () => { Store.loadDemo(); toast('Demo data loaded'); route(); };
      return;
    }
    view.innerHTML = `
      <h2 class="section-title">Open (${open.length})</h2>
      ${open.map(orderCard).join('') || '<p class="muted">Nothing left to pick. 🎉</p>'}
      ${done.length ? `
        <details class="done-list">
          <summary>Completed (${done.length})</summary>
          ${done.map(orderCard).join('')}
        </details>` : ''}`;
  }

  // ---------- picker: pick a single order ----------
  function pickView(id) {
    const o = Store.order(id);
    if (!o) { setChrome('Not found', '#/'); view.innerHTML = '<p class="empty">That pick sheet no longer exists.</p>'; return; }
    setChrome(o.number, '#/');

    const render = () => {
      const p = Store.progress(o);
      const pct = p.need ? Math.round((p.got / p.need) * 100) : 0;
      const todo = o.lines.filter((l) => l.picked < l.qty);
      const picked = o.lines.filter((l) => l.picked >= l.qty);
      const lineHtml = (l) => {
        const full = l.picked >= l.qty;
        const partial = l.picked > 0 && !full;
        return `
          <li class="line ${full ? 'done' : ''} ${partial ? 'partial' : ''}" data-act="line" data-arg="${esc(l.sku)}">
            <span class="check" aria-hidden="true">${full ? '✓' : ''}</span>
            <span class="line-main">
              <span class="line-name">${esc(itemName(l.sku))}</span>
              <span class="muted small">SKU ${esc(l.sku)}${itemLoc(l.sku) ? ` · ${esc(itemLoc(l.sku))}` : ''}</span>
            </span>
            <span class="qty ${full ? 'qty-ok' : partial ? 'qty-warn' : ''}">${l.picked}<small>/${l.qty}</small></span>
          </li>`;
      };
      view.innerHTML = `
        <section class="card summary">
          ${o.customer ? `<div class="muted">${esc(o.customer)}</div>` : ''}
          <div class="progress big"><span style="width:${pct}%"></span></div>
          <div class="row small"><span>${p.linesDone} of ${p.lines} lines</span><span>${p.got} of ${p.need} units</span></div>
        </section>
        ${p.done && o.status !== 'complete' ? `
          <div class="banner ok">All items picked!
            <button class="btn btn-primary" data-act="complete">Mark order complete</button></div>` : ''}
        ${o.status === 'complete' ? '<div class="banner ok">This order is complete.</div>' : ''}
        ${todo.length ? `<h2 class="section-title">To pick (${todo.length})</h2><ul class="lines">${todo.map(lineHtml).join('')}</ul>` : ''}
        ${picked.length ? `<h2 class="section-title">Picked (${picked.length})</h2><ul class="lines">${picked.map(lineHtml).join('')}</ul>` : ''}
        <p class="muted small center">Tap an item to check it off or change its quantity by hand.</p>
        <div class="bottom-bar">
          <button class="btn btn-ghost" data-act="manual">Type SKU</button>
          <button class="btn btn-primary btn-scan" data-act="scan">Scan QR</button>
        </div>`;
    };

    // Shared by camera scans and typed SKUs.
    async function handleSku(raw, fromCamera) {
      const sku = skuFromScan(raw);
      const line = o.lines.find((l) => l.sku === sku);
      const say = (msg, bad) => (fromCamera ? Scanner.setStatus(msg, bad) : toast(msg, bad ? 'error' : 'ok'));
      if (!line) {
        feedback('error');
        say(`${sku} is not on this pick sheet`, true);
        return;
      }
      const remaining = line.qty - line.picked;
      if (remaining <= 0) {
        feedback('error');
        say(`${itemName(sku)} is already fully picked`, true);
        return;
      }
      let add = 1;
      if (line.qty > 1) {
        if (fromCamera) Scanner.pause();
        feedback('ok');
        add = await askQty({
          title: itemName(sku),
          subtitle: `SKU ${esc(sku)} · ${line.picked} of ${line.qty} picked. How many did you just pick?`,
          value: remaining, min: 1, max: remaining, okText: 'Add',
        });
        if (fromCamera) Scanner.resume();
        if (add == null) { say('Point the camera at a QR code'); return; }
      } else {
        feedback('ok');
      }
      Store.setPicked(o.id, sku, line.picked + add);
      render();
      const nowDone = line.picked >= line.qty;
      say(`✓ ${itemName(sku)} ${nowDone ? 'picked' : `${line.picked}/${line.qty}`}`);
      if (Store.progress(o).done) {
        if (fromCamera) setTimeout(() => Scanner.close(), 700);
        toast('All items on this sheet are picked!', 'ok');
      }
    }

    actions.scan = () => Scanner.open((text) => handleSku(text, true));
    actions.manual = async () => { const s = await askSku(); if (s) handleSku(s, false); };
    actions.line = async (sku) => {
      const line = o.lines.find((l) => l.sku === sku);
      if (line.qty === 1) {
        Store.setPicked(o.id, sku, line.picked ? 0 : 1);
      } else {
        const n = await askQty({
          title: itemName(sku),
          subtitle: `SKU ${esc(sku)} · Set the total quantity picked (needed: ${line.qty}).`,
          value: line.picked, min: 0, max: line.qty, okText: 'Save',
        });
        if (n == null) return;
        Store.setPicked(o.id, sku, n);
      }
      render();
    };
    actions.complete = () => { Store.setOrderStatus(o.id, 'complete'); toast(`${o.number} complete`, 'ok'); location.hash = '#/'; };

    document.getElementById('scanManual').onclick = async () => {
      Scanner.pause();
      const s = await askSku();
      Scanner.resume();
      if (s) handleSku(s, true);
    };
    render();
  }

  // ---------- admin ----------
  function adminLogin() {
    setChrome('Admin', '#/');
    view.innerHTML = `
      <form class="card narrow" id="pinForm">
        <h2>Administrator</h2>
        <label>PIN<input name="pin" type="password" inputmode="numeric" autocomplete="off" required></label>
        <p class="form-error" hidden></p>
        <button class="btn btn-primary btn-block">Unlock</button>
        <p class="muted small">Demo PIN is <strong>1234</strong>. Change it under Admin → Settings.</p>
      </form>`;
    const form = document.getElementById('pinForm');
    form.elements.pin.focus();
    form.onsubmit = (e) => {
      e.preventDefault();
      if (form.elements.pin.value === Store.pin()) {
        sessionStorage.setItem('chickenco.admin', '1');
        route();
      } else {
        const err = form.querySelector('.form-error');
        err.textContent = 'Incorrect PIN';
        err.hidden = false;
        form.elements.pin.value = '';
      }
    };
  }

  function adminView(tab) {
    setChrome('Admin', '#/');
    const tabs = [['items', 'Items'], ['orders', 'Pick Sheets'], ['settings', 'Settings']];
    const nav = `<nav class="tabs">${tabs.map(([k, label]) =>
      `<a href="#/admin/${k}" class="${k === tab ? 'active' : ''}">${label}</a>`).join('')}</nav>`;
    if (tab === 'orders') return adminOrders(nav);
    if (tab === 'settings') return adminSettings(nav);
    return adminItems(nav);
  }

  function itemForm(it = {}) {
    return `
      <label>SKU<input name="sku" value="${esc(it.sku)}" autocomplete="off" autocapitalize="characters" required></label>
      <label>Item name<input name="name" value="${esc(it.name)}" autocomplete="off" required></label>
      <label>Location <span class="muted">(optional)</span><input name="location" value="${esc(it.location)}" placeholder="e.g. Cooler A2" autocomplete="off"></label>
      ${it.sku ? `<div class="qr-preview">${qrSvg(it.sku)}<span class="muted small">QR code for this SKU</span></div>` : ''}`;
  }

  function adminItems(nav) {
    let filter = '';
    const render = () => {
      const list = Store.items().filter((i) => !filter || `${i.sku} ${i.name} ${i.location}`.toLowerCase().includes(filter));
      document.getElementById('itemList').innerHTML = list.map((i) => `
        <li class="line">
          <span class="line-main">
            <span class="line-name">${esc(i.name)}</span>
            <span class="muted small">SKU ${esc(i.sku)}${i.location ? ` · ${esc(i.location)}` : ''}</span>
          </span>
          <button class="btn btn-small btn-ghost" data-act="edit" data-arg="${esc(i.sku)}">Edit</button>
        </li>`).join('') || `<li class="muted empty">${filter ? 'No matching items.' : 'No items yet. Add one, or import a list.'}</li>`;
      document.getElementById('itemCount').textContent = `${Store.items().length} items`;
    };
    view.innerHTML = `
      ${nav}
      <div class="toolbar">
        <button class="btn btn-primary" data-act="add">+ Add item</button>
        <button class="btn btn-ghost" data-act="import">Import list</button>
        <a class="btn btn-ghost" href="#/admin/labels">Print QR labels</a>
      </div>
      <input class="search" type="search" placeholder="Search SKU, name or location" id="itemSearch">
      <p class="muted small" id="itemCount"></p>
      <ul class="lines" id="itemList"></ul>`;
    document.getElementById('itemSearch').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); render(); };

    actions.add = async () => {
      const saved = await ask({
        title: 'Add item', okText: 'Save', body: itemForm(),
        onOk: (f) => Store.saveItem({ sku: f.elements.sku.value, name: f.elements.name.value, location: f.elements.location.value }),
      });
      if (saved) { toast(`Added ${saved.sku}`, 'ok'); render(); }
    };
    actions.edit = async (sku) => {
      const it = Store.item(sku);
      let deleted = false;
      const saved = await ask({
        title: 'Edit item', okText: 'Save', body: `${itemForm(it)}<button type="button" class="btn btn-ghost btn-danger-text btn-block" data-del>Delete item</button>`,
        onOpen: (f) => {
          f.querySelector('[data-del]').onclick = () => { deleted = true; f.requestSubmit(); };
        },
        onOk: (f) => (deleted ? 'delete'
          : Store.saveItem({ sku: f.elements.sku.value, name: f.elements.name.value, location: f.elements.location.value }, sku)),
      });
      if (saved === 'delete') {
        const used = Store.orders().some((o) => o.status !== 'complete' && o.lines.some((l) => l.sku === sku));
        const ok = await confirmBox('Delete item?', `${it.name} (${sku}) will be removed from the catalog.${used ? ' It is still on an open pick sheet.' : ''}`, 'Delete', true);
        if (ok) { Store.deleteItem(sku); toast('Item deleted'); }
      } else if (saved) toast('Saved', 'ok');
      render();
    };
    actions.import = async () => {
      const res = await ask({
        title: 'Import items', okText: 'Import',
        body: `<p class="muted small">Paste one item per line: <code>SKU, Name, Location</code>. You can copy straight from a spreadsheet. Existing SKUs are updated.</p>
          <textarea name="csv" rows="8" placeholder="CC-1001, Whole Chicken 4lb, Cooler A1"></textarea>`,
        onOk: (f) => {
          if (!f.elements.csv.value.trim()) throw new Error('Paste at least one line');
          return Store.importItemsCsv(f.elements.csv.value);
        },
      });
      if (res) { toast(`${res.added} added, ${res.updated} updated${res.skipped ? `, ${res.skipped} skipped` : ''}`, 'ok'); render(); }
    };
    render();
  }

  function adminOrders(nav) {
    const list = Store.orders();
    view.innerHTML = `
      ${nav}
      <div class="toolbar"><a class="btn btn-primary" href="#/admin/order/new">+ New pick sheet</a></div>
      <ul class="lines">
        ${list.map((o) => {
          const p = Store.progress(o);
          return `
            <li class="line">
              <span class="line-main">
                <span class="line-name">${esc(o.number)} ${o.status === 'complete' ? '<span class="pill pill-ok">Complete</span>' : ''}</span>
                <span class="muted small">${o.customer ? `${esc(o.customer)} · ` : ''}${p.lines} lines · ${p.got}/${p.need} picked</span>
              </span>
              <span class="btn-group">
                <a class="btn btn-small btn-ghost" href="#/admin/order/${o.id}">Edit</a>
                <button class="btn btn-small btn-ghost" data-act="more" data-arg="${o.id}">⋯</button>
              </span>
            </li>`;
        }).join('') || '<li class="muted empty">No pick sheets yet.</li>'}
      </ul>`;
    actions.more = async (id) => {
      const o = Store.order(id);
      let choice = null;
      await ask({
        title: o.number, okText: 'Close', cancelText: '',
        body: `
          <button type="button" class="btn btn-ghost btn-block" data-choice="reset">Reset picking progress</button>
          <button type="button" class="btn btn-ghost btn-block" data-choice="${o.status === 'complete' ? 'reopen' : 'close'}">${o.status === 'complete' ? 'Reopen order' : 'Mark complete'}</button>
          <button type="button" class="btn btn-ghost btn-danger-text btn-block" data-choice="delete">Delete pick sheet</button>`,
        onOpen: (f) => f.querySelectorAll('[data-choice]').forEach((b) => {
          b.onclick = () => { choice = b.dataset.choice; f.requestSubmit(); };
        }),
      });
      if (choice === 'reset' && await confirmBox('Reset progress?', `All picked quantities on ${o.number} go back to 0.`, 'Reset', true)) Store.resetOrder(id);
      if (choice === 'reopen') Store.setOrderStatus(id, 'open');
      if (choice === 'close') Store.setOrderStatus(id, 'complete');
      if (choice === 'delete' && await confirmBox('Delete pick sheet?', `${o.number} will be permanently deleted.`, 'Delete', true)) Store.deleteOrder(id);
      route();
    };
  }

  function orderEditor(id) {
    const existing = id && id !== 'new' ? Store.order(id) : null;
    if (!orderDraft || orderDraft.id !== (existing ? existing.id : 'new')) {
      orderDraft = existing
        ? { id: existing.id, number: existing.number, customer: existing.customer, lines: existing.lines.map((l) => ({ sku: l.sku, qty: l.qty })) }
        : { id: 'new', number: '', customer: '', lines: [] };
    }
    const d = orderDraft;
    setChrome(existing ? `Edit ${existing.number}` : 'New pick sheet', '#/admin/orders');

    const addLine = (sku, qty) => {
      const it = Store.item(sku);
      if (!it) throw new Error(`${Store.normSku(sku)} is not in the item list`);
      const line = d.lines.find((l) => l.sku === it.sku);
      if (line) line.qty += qty; else d.lines.push({ sku: it.sku, qty });
      return it;
    };

    const render = () => {
      view.innerHTML = `
        <form class="card" id="orderForm">
          <label>Order / pick sheet #<input name="number" value="${esc(d.number)}" autocomplete="off" required></label>
          <label>Customer <span class="muted">(optional)</span><input name="customer" value="${esc(d.customer)}" autocomplete="off"></label>
        </form>
        <h2 class="section-title">Items (${d.lines.length})</h2>
        <ul class="lines">
          ${d.lines.map((l, i) => `
            <li class="line">
              <span class="line-main">
                <span class="line-name">${esc(itemName(l.sku))}</span>
                <span class="muted small">SKU ${esc(l.sku)}</span>
              </span>
              <button class="btn btn-small btn-ghost qty-btn" data-act="qty" data-arg="${i}">Qty ${l.qty}</button>
              <button class="btn btn-small btn-ghost btn-danger-text" data-act="remove" data-arg="${i}" aria-label="Remove">✕</button>
            </li>`).join('') || '<li class="muted empty">No items on this sheet yet.</li>'}
        </ul>
        <form class="card add-line" id="addForm">
          <label>Add item<input name="sku" list="skuList" placeholder="Type SKU or name" autocomplete="off"></label>
          <label class="qty-field">Qty<input name="qty" type="number" inputmode="numeric" min="1" value="1"></label>
          <button class="btn btn-primary">Add</button>
          ${skuDatalist()}
        </form>
        <div class="toolbar"><button class="btn btn-ghost" data-act="scanAdd">Scan items to add</button></div>
        ${Store.items().length ? '' : '<p class="banner warn">There are no items in the catalog yet. Add items under Admin → Items first.</p>'}
        <div class="bottom-bar">
          <a class="btn btn-ghost" href="#/admin/orders">Cancel</a>
          <button class="btn btn-primary" data-act="save">Save pick sheet</button>
        </div>`;
      const form = document.getElementById('orderForm');
      form.oninput = () => { d.number = form.elements.number.value; d.customer = form.elements.customer.value; };
      const addForm = document.getElementById('addForm');
      addForm.onsubmit = (e) => {
        e.preventDefault();
        const raw = addForm.elements.sku.value.trim();
        const qty = parseInt(addForm.elements.qty.value, 10);
        if (!raw) return;
        if (!(qty > 0)) { toast('Quantity must be at least 1', 'error'); return; }
        // Accept a SKU, or an exact item name picked from the suggestions.
        const byName = Store.items().find((i) => i.name.toLowerCase() === raw.toLowerCase());
        try { addLine(byName ? byName.sku : raw, qty); render(); document.querySelector('#addForm input[name=sku]').focus(); } catch (err) { toast(err.message, 'error'); }
      };
    };

    actions.qty = async (i) => {
      const n = await askQty({ title: itemName(d.lines[i].sku), subtitle: 'Quantity needed', value: d.lines[i].qty, min: 1 });
      if (n) { d.lines[i].qty = n; render(); }
    };
    actions.remove = (i) => { d.lines.splice(Number(i), 1); render(); };
    actions.scanAdd = () => Scanner.open(async (text) => {
      const sku = skuFromScan(text);
      if (!Store.item(sku)) { feedback('error'); Scanner.setStatus(`${sku} is not in the item list`, true); return; }
      feedback('ok');
      Scanner.pause();
      const n = await askQty({ title: itemName(sku), subtitle: 'How many are needed on this sheet?', value: 1, min: 1, okText: 'Add' });
      Scanner.resume();
      if (n) { addLine(sku, n); render(); Scanner.setStatus(`✓ Added ${n} × ${itemName(sku)}`); }
    });
    document.getElementById('scanManual').onclick = async () => {
      Scanner.pause();
      const s = await askSku();
      Scanner.resume();
      if (!s) return;
      try { const it = addLine(s, 1); render(); Scanner.setStatus(`✓ Added 1 × ${it.name}`); } catch (err) { Scanner.setStatus(err.message, true); }
    };
    actions.save = () => {
      try {
        const saved = Store.saveOrder(d, existing && existing.id);
        orderDraft = null;
        toast(`Saved ${saved.number}`, 'ok');
        location.hash = '#/admin/orders';
      } catch (err) { toast(err.message, 'error'); }
    };
    render();
  }

  function adminSettings(nav) {
    view.innerHTML = `
      ${nav}
      <section class="card">
        <h2>Admin PIN</h2>
        <button class="btn btn-ghost" data-act="pin">Change PIN</button>
        <button class="btn btn-ghost" data-act="lock">Lock admin</button>
      </section>
      <section class="card">
        <h2>Data</h2>
        <p class="muted small">This demo keeps data on this device only. Use a backup file to move data between phones.</p>
        <div class="toolbar">
          <button class="btn btn-ghost" data-act="demo">Load demo data</button>
          <button class="btn btn-ghost" data-act="export">Download backup</button>
          <label class="btn btn-ghost">Restore backup<input type="file" accept="application/json,.json" id="restoreFile" hidden></label>
          <button class="btn btn-ghost btn-danger-text" data-act="wipe">Erase all data</button>
        </div>
      </section>`;
    actions.pin = async () => {
      const ok = await ask({
        title: 'Change PIN', okText: 'Save',
        body: `<label>New PIN<input name="a" type="password" inputmode="numeric" autocomplete="new-password"></label>
               <label>Confirm new PIN<input name="b" type="password" inputmode="numeric" autocomplete="new-password"></label>`,
        onOk: (f) => {
          const a = f.elements.a.value;
          if (!/^\d{4,8}$/.test(a)) throw new Error('PIN must be 4–8 digits');
          if (a !== f.elements.b.value) throw new Error('PINs do not match');
          Store.setPin(a);
          return true;
        },
      });
      if (ok) toast('PIN updated', 'ok');
    };
    actions.lock = () => { sessionStorage.removeItem('chickenco.admin'); location.hash = '#/'; };
    actions.demo = () => { Store.loadDemo(); toast('Demo data loaded', 'ok'); };
    actions.export = () => {
      const blob = new Blob([Store.exportJson()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `chickenco-pick-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    document.getElementById('restoreFile').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!await confirmBox('Restore backup?', 'This replaces all items and pick sheets on this device.', 'Restore', true)) return;
      try { Store.importJson(await file.text()); toast('Backup restored', 'ok'); } catch (err) { toast(err.message, 'error'); }
    };
    actions.wipe = async () => {
      if (await confirmBox('Erase all data?', 'Every item and pick sheet on this device will be deleted. This cannot be undone.', 'Erase', true)) {
        Store.clearAll();
        toast('All data erased');
      }
    };
  }

  function labelsView() {
    setChrome('QR labels', '#/admin/items');
    const list = Store.items();
    view.innerHTML = `
      <div class="toolbar no-print">
        <button class="btn btn-primary" data-act="print">Print</button>
        <span class="muted small">${list.length} labels. Stick these on shelves or bins; scanning one checks that SKU off a pick sheet.</span>
      </div>
      <div class="labels">
        ${list.map((i) => `
          <div class="label">
            ${qrSvg(i.sku)}
            <strong>${esc(i.sku)}</strong>
            <span>${esc(i.name)}</span>
          </div>`).join('') || '<p class="muted">No items yet.</p>'}
      </div>`;
    actions.print = () => window.print();
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  route();
})();
