// Management: list all orders, and enter / edit an order from the VIP pick list.
import { api, qs } from '../api.js';
import { esc, toast, choose, confirmBox, statusPill, fmtTime, ask } from '../ui.js';

const view = document.getElementById('view');
const UNITS = ['CASES', 'BTLS', 'KEGS', 'MISC'];

export async function ordersView(ctx) {
  ctx.chrome('Manage orders', '#/');
  const state = { status: '', truck: '', q: '' };
  view.innerHTML = `
    <div class="toolbar"><a class="btn btn-primary" href="#/orders/new">+ New order</a></div>
    <div class="filters">
      <select id="fTruck"><option value="">All trucks</option>${ctx.trucks.map((t) => `<option value="${t.truck}">Truck ${t.truck}</option>`).join('')}</select>
      <select id="fStatus"><option value="">Any status</option><option value="open">Not started</option><option value="picking">Picking</option><option value="review">Needs review</option><option value="done">Done</option></select>
      <input id="fQ" type="search" placeholder="Search store or stop">
    </div>
    <ul class="lines" id="orderList"></ul>`;
  const list = document.getElementById('orderList');
  const render = async () => {
    const orders = await api.get(`/orders${qs(state)}`);
    list.innerHTML = orders.map((o) => `
      <li class="line" data-act="open" data-arg="${o.id}">
        <span class="line-main">
          <span class="line-name">${esc(o.store)}</span>
          <span class="muted small">${esc(ctx.truckName(o.truck))} · Stop ${esc(o.stop || '—')} · ${o.line_count} lines${o.order_date ? ` · ${esc(o.order_date)}` : ''}${o.picker_name ? ` · ${esc(o.picker_name)}` : ''}</span>
        </span>
        ${statusPill(o.status)}
      </li>`).join('') || '<li class="empty muted">No orders match.</li>';
  };
  document.getElementById('fTruck').onchange = (e) => { state.truck = e.target.value; render(); };
  document.getElementById('fStatus').onchange = (e) => { state.status = e.target.value; render(); };
  let t;
  document.getElementById('fQ').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 250); };

  ctx.actions.open = async (id) => {
    const o = await api.get(`/orders/${id}`);
    const pick = await choose(`${o.store} · Stop ${o.stop || '—'}`, [
      { key: 'view', label: 'Open pick list', primary: true },
      o.status === 'review' && { key: 'review', label: 'Review outs' },
      { key: 'edit', label: 'Edit order' },
      ['open', 'picking'].includes(o.status) && { key: 'assign', label: 'Assign to a picker' },
      o.status === 'picking' && { key: 'release', label: `Release from ${o.picker_name}` },
      o.status === 'done' && { key: 'reopen', label: 'Reopen order' },
      { key: 'history', label: 'History' },
      { key: 'delete', label: 'Delete order', danger: true },
    ].filter(Boolean), `${esc(ctx.truckName(o.truck))} · ${statusPill(o.status)}`);
    try {
      if (pick === 'view') location.hash = `#/order/${o.id}`;
      if (pick === 'review') location.hash = `#/review/${o.id}`;
      if (pick === 'edit') location.hash = `#/orders/${o.id}/edit`;
      if (pick === 'assign') await assignPicker(o);
      if (pick === 'release') { await api.post(`/orders/${o.id}/release`); toast('Released'); }
      if (pick === 'reopen' && await confirmBox('Reopen order?', 'It goes back to picking, and outs will need to be reviewed again.', 'Reopen')) await api.post(`/orders/${o.id}/reopen`);
      if (pick === 'history') await showHistory(o);
      if (pick === 'delete' && await confirmBox('Delete order?', `${o.store} (Stop ${o.stop}) and its picking history will be deleted. This cannot be undone.`, 'Delete', true)) {
        await api.del(`/orders/${o.id}`);
        toast('Order deleted');
      }
    } catch (err) { toast(err.message, 'error'); }
    render();
  };

  ctx.refresh = render;
  await render();
}

export async function assignPicker(o) {
  const people = await api.get('/employees');
  const pick = await choose('Assign to', people.map((p) => ({ key: String(p.id), label: p.name })));
  if (pick) { await api.post(`/orders/${o.id}/assign`, { userId: Number(pick) }); toast('Assigned', 'ok'); }
}

const EVENT_TEXT = {
  created: () => 'Order created',
  edited: () => 'Order edited',
  started: () => 'Started picking',
  released: () => 'Stopped picking',
  assigned: (d) => `Assigned to ${d.to}`,
  picked: (d) => `#${d.code}: picked ${d.from} → ${d.to}${d.via === 'scan' ? ' (scanned)' : ''}`,
  out: (d) => `#${d.code}: marked ${d.qty} out (${d.reason === 'cant_find' ? "can't find" : 'out of stock'})`,
  out_cleared: (d) => `#${d.code}: out cleared`,
  submitted: (d) => `Sent to supervisor (${d.outs} out)`,
  completed: () => 'Finished',
  out_confirmed: (d) => `#${d.code}: out confirmed`,
  found: (d) => `#${d.code}: supervisor found ${d.qty}`,
  sent_back: (d) => `#${d.code}: sent back to picker`,
  approved: () => 'Approved',
  reopened: () => 'Reopened',
};

async function showHistory(o) {
  await ask({
    title: 'History',
    okText: 'Close',
    cancelText: '',
    body: `<ul class="history">${(o.events || []).map((e) => `
      <li><span>${esc((EVENT_TEXT[e.type] || (() => e.type))(e.detail || {}))}</span>
      <span class="muted small">${esc(e.user_name || '')} · ${fmtTime(e.at)}</span></li>`).join('') || '<li class="muted">No history.</li>'}</ul>`,
  });
}

// ---------- order editor ----------
export async function orderEditView(ctx, id) {
  const editing = !!id;
  const [order, items] = await Promise.all([editing ? api.get(`/orders/${id}`) : null, api.get('/items')]);
  const itemMap = new Map(items.map((i) => [i.code, i]));
  ctx.chrome(editing ? 'Edit order' : 'New order', '#/orders');

  const d = order ? {
    ...order,
    truck: order.truck,
    lines: order.lines.map((l) => ({ id: l.id, code: l.code, description: l.description, qty: l.qty, unit: l.unit, vipOut: l.out_reason === 'vip' })),
  } : { truck: '', stop: '', store: '', account_no: '', address: '', city: '', state: 'KY', day_no: '', order_date: '', zone: '', lines: [] };
  if (!d.lines.length) d.lines.push({ code: '', description: '', qty: 1, unit: 'CASES', vipOut: false });

  const field = (name, label, attrs = '') => `<label>${label}<input name="${name}" value="${esc(d[name])}" autocomplete="off" ${attrs}></label>`;

  function lineHtml(l, i) {
    const known = itemMap.get(l.code);
    return `
      <div class="entry-line" data-i="${i}">
        <span class="entry-num">${i + 1}</span>
        <input class="e-code" name="code" value="${esc(l.code)}" placeholder="Code" inputmode="numeric" autocomplete="off" list="itemCodes" aria-label="Item code">
        <input class="e-desc" name="description" value="${esc(l.description)}" placeholder="${l.code && !known ? 'New item – type description' : 'Description'}" ${known ? 'readonly tabindex="-1"' : ''} aria-label="Description">
        <input class="e-qty" name="qty" type="number" inputmode="numeric" min="1" value="${l.qty}" aria-label="Quantity">
        <select class="e-unit" name="unit" aria-label="Unit">${UNITS.map((u) => `<option ${u === l.unit ? 'selected' : ''}>${u}</option>`).join('')}</select>
        <label class="e-out" title="Printed *OUT on the VIP sheet"><input type="checkbox" name="vipOut" ${l.vipOut ? 'checked' : ''}> *OUT</label>
        <button type="button" class="btn btn-small btn-ghost btn-danger-text e-del" data-act="delLine" data-arg="${i}" aria-label="Remove line">✕</button>
      </div>`;
  }

  function render() {
    view.innerHTML = `
      <form id="orderForm" class="order-form" autocomplete="off">
        <section class="card">
          <h2>Pick list header</h2>
          <div class="grid-2">
            <label>Truck<select name="truck" required><option value="">Choose…</option>${ctx.trucks.map((t) => `<option value="${t.truck}" ${String(t.truck) === String(d.truck) ? 'selected' : ''}>Truck ${t.truck} (Load #${esc(t.load)})</option>`).join('')}</select></label>
            ${field('stop', 'Stop', 'inputmode="numeric"')}
          </div>
          ${field('store', 'Store name', 'required autocapitalize="characters"')}
          <div class="grid-2">
            ${field('account_no', 'Account #', 'inputmode="numeric"')}
            ${field('address', 'Address', 'autocapitalize="characters"')}
          </div>
          <div class="grid-4">
            ${field('city', 'City', 'autocapitalize="characters"')}
            ${field('state', 'State', 'autocapitalize="characters" maxlength="2"')}
            ${field('day_no', 'Day #', 'inputmode="numeric"')}
            ${field('zone', 'Zone', 'inputmode="numeric"')}
          </div>
          ${field('order_date', 'Date', 'placeholder="MM/DD/YY" inputmode="numeric"')}
        </section>
        <section class="card">
          <h2>Items (${d.lines.length})</h2>
          <div class="entry-head"><span></span><span>Code</span><span>Product description</span><span>Qty</span><span>Unit</span><span></span><span></span></div>
          <div id="lines">${d.lines.map(lineHtml).join('')}</div>
          <button type="button" class="btn btn-ghost btn-block" data-act="addLine">+ Add line</button>
          <p class="muted small">Tip: press Enter in the quantity box to add the next line. New codes are added to the item list automatically.</p>
        </section>
        <datalist id="itemCodes">${items.map((i) => `<option value="${esc(i.code)}">${esc(i.description)}</option>`).join('')}</datalist>
        <div class="bottom-bar">
          <a class="btn btn-ghost" href="#/orders">Cancel</a>
          <button type="submit" class="btn btn-primary btn-scan">Save order</button>
        </div>
      </form>`;
    const form = document.getElementById('orderForm');
    form.addEventListener('input', onInput);
    form.addEventListener('change', onInput);
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('.e-qty, .e-code, .e-desc')) {
        e.preventDefault();
        const row = e.target.closest('.entry-line');
        if (e.target.matches('.e-qty') && Number(row.dataset.i) === d.lines.length - 1) addLine();
        else row.querySelector(e.target.matches('.e-code') ? (row.querySelector('.e-desc').readOnly ? '.e-qty' : '.e-desc') : '.e-qty').focus();
      }
    });
    form.onsubmit = save;
  }

  function onInput(e) {
    const t = e.target;
    const row = t.closest('.entry-line');
    if (!row) { if (t.name) d[t.name] = t.value; return; }
    const l = d.lines[Number(row.dataset.i)];
    if (t.name === 'vipOut') l.vipOut = t.checked;
    else if (t.name === 'qty') l.qty = parseInt(t.value, 10) || 0;
    else l[t.name] = t.value;
    if (t.name === 'code') {
      l.code = t.value.trim().toUpperCase();
      const known = itemMap.get(l.code);
      const desc = row.querySelector('.e-desc');
      desc.readOnly = !!known;
      desc.tabIndex = known ? -1 : 0;
      if (known) { l.description = known.description; desc.value = known.description; }
      else if (desc.value && itemMap.has(desc.dataset.prev || '')) { l.description = ''; desc.value = ''; }
      desc.dataset.prev = l.code;
      desc.placeholder = l.code && !known ? 'New item – type description' : 'Description';
    }
  }

  function addLine() {
    d.lines.push({ code: '', description: '', qty: 1, unit: d.lines.at(-1)?.unit || 'CASES', vipOut: false });
    const wrap = document.getElementById('lines');
    wrap.insertAdjacentHTML('beforeend', lineHtml(d.lines.at(-1), d.lines.length - 1));
    view.querySelector('.card:nth-of-type(2) h2').textContent = `Items (${d.lines.length})`;
    wrap.lastElementChild.querySelector('.e-code').focus();
  }

  ctx.actions.addLine = addLine;
  ctx.actions.delLine = (i) => {
    d.lines.splice(Number(i), 1);
    if (!d.lines.length) d.lines.push({ code: '', description: '', qty: 1, unit: 'CASES', vipOut: false });
    render();
  };

  async function save(e) {
    e.preventDefault();
    const body = { ...d, lines: d.lines.filter((l) => l.code.trim()) };
    delete body.events;
    const truck = ctx.trucks.find((t) => String(t.truck) === String(d.truck));
    if (truck) body.load_no = truck.load;
    try {
      const saved = editing ? await api.put(`/orders/${id}`, body) : await api.post('/orders', body);
      toast(`Saved ${saved.store}`, 'ok');
      location.hash = '#/orders';
    } catch (err) { toast(err.message, 'error'); }
  }

  render();
}
