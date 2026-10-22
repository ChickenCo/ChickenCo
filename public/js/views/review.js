// Supervisor: double-check items pickers marked out, then approve the order.
import { api } from '../api.js';
import { esc, toast, askQty, choose, confirmBox, fmtTime, UNIT_SHORT, OUT_REASONS } from '../ui.js';
import { orderHeader, lineRow } from './pick.js';
import { notesHtml, addNote, deleteNote } from '../notes.js';

const view = document.getElementById('view');

export async function reviewListView(ctx) {
  ctx.chrome('Outs to review', '#/');
  const render = async () => {
    const orders = await api.get('/review');
    view.innerHTML = orders.length ? orders.map((o) => `
      <a class="card order-card status-review" href="#/review/${o.id}">
        <div class="row"><span class="stop">${esc(ctx.truckName(o.truck))} · Stop ${esc(o.stop || '—')}</span>
          <span class="pill pill-danger">${o.lines_out} out</span></div>
        <strong class="store">${esc(o.store)}</strong>
        <div class="muted small">Picked by ${esc(o.picker_name || '—')} · sent ${fmtTime(o.submitted_at)}</div>
      </a>`).join('') : '<div class="empty"><p><strong>Nothing to review.</strong></p><p class="muted">When a picker marks something out, the order shows up here and you get a notification.</p></div>';
  };
  ctx.refresh = render;
  await render();
}

export async function reviewView(ctx, id) {
  let o = await api.get(`/orders/${id}`);

  function render() {
    ctx.chrome(`Review · Stop ${o.stop || '—'}`, '#/review');
    const outs = o.lines.filter((l) => l.out_qty > 0);
    const rest = o.lines.filter((l) => !l.out_qty);
    const unresolved = outs.filter((l) => l.out_status !== 'confirmed');
    const outCard = (l) => `
      <div class="card out-card ${l.out_status === 'confirmed' ? 'confirmed' : ''}">
        <div class="row"><strong>${esc(l.description)}</strong><span class="qty-out">${l.out_qty} ${esc(UNIT_SHORT[l.unit] || '')}</span></div>
        <div class="muted small">#${esc(l.code)} · needed ${l.qty}, picked ${l.picked}</div>
        <div class="small">${esc(OUT_REASONS[l.out_reason] || '')}${l.out_by_name ? ` · marked by ${esc(l.out_by_name)}` : ''}${l.out_at ? ` · ${fmtTime(l.out_at)}` : ''}</div>
        ${o.status === 'review' ? (l.out_status === 'confirmed'
          ? `<div class="row small"><span class="text-ok">✓ Confirmed out${l.reviewed_by_name ? ` by ${esc(l.reviewed_by_name)}` : ''}</span>
             <button class="btn btn-small btn-ghost" data-act="found" data-arg="${l.id}">Found it after all</button></div>`
          : `<div class="btn-row">
              <button class="btn btn-primary" data-act="confirm" data-arg="${l.id}">Confirm out</button>
              <button class="btn btn-ghost" data-act="found" data-arg="${l.id}">Found it</button>
             </div>`) : ''}
      </div>`;
    view.innerHTML = `
      ${orderHeader(o, ctx)}
      ${o.status !== 'review' ? '<div class="banner">This order is not waiting for review anymore.</div>' : ''}
      ${notesHtml(o.notes, ctx)}
      <p class="muted small">Picked by <b>${esc(o.picker_name || '—')}</b>. Check the shelf for each out item.</p>
      <h2 class="section-title">Outs (${outs.length})</h2>
      ${outs.map(outCard).join('')}
      ${rest.length ? `<details class="done-list"><summary>Other items (${rest.length})</summary><ul class="lines">${rest.map((l) => lineRow(l, { act: '' })).join('')}</ul></details>` : ''}
      ${o.status === 'review' ? `<div class="bottom-bar">
        <button class="btn btn-ghost" data-act="pick">Open pick list</button>
        <button class="btn btn-primary btn-scan" data-act="approve" ${unresolved.length ? 'disabled' : ''}>${unresolved.length ? `${unresolved.length} left to check` : 'Approve order'}</button>
      </div>` : ''}`;
  }

  const update = (fresh) => { o = fresh; render(); };
  const lineById = (lineId) => o.lines.find((l) => String(l.id) === lineId);

  ctx.actions.confirm = async (lineId) => {
    try { update(await api.post(`/orders/${o.id}/lines/${lineId}/confirm-out`)); } catch (err) { toast(err.message, 'error'); }
  };
  ctx.actions.found = async (lineId) => {
    const line = lineById(lineId);
    const how = await choose(`Found: ${line.description}`, [
      { key: 'self', label: 'I pulled it myself (add to order)', primary: true },
      { key: 'back', label: `Send back to ${o.picker_name || 'the picker'} to pick` },
    ]);
    try {
      if (how === 'self') {
        const n = await askQty({ title: line.description, subtitle: `How many did you find? (out: ${line.out_qty})`, value: line.out_qty, min: 1, max: line.out_qty, okText: 'Add to order' });
        if (n) update(await api.post(`/orders/${o.id}/lines/${line.id}/found`, { qty: n }));
      } else if (how === 'back') {
        await api.post(`/orders/${o.id}/lines/${line.id}/send-back`);
        toast(`Sent back to ${o.picker_name || 'the picker'}`, 'ok');
        location.hash = '#/review';
      }
    } catch (err) { toast(err.message, 'error'); }
  };
  ctx.actions.approve = async () => {
    if (!await confirmBox('Approve order?', 'The confirmed outs are recorded and the order is marked done.', 'Approve')) return;
    try { await api.post(`/orders/${o.id}/approve`); toast('Order approved', 'ok'); location.hash = '#/review'; } catch (err) { toast(err.message, 'error'); }
  };
  ctx.actions.pick = () => { location.hash = `#/order/${o.id}`; };
  ctx.actions.addNote = async () => { if (await addNote({ orderId: o.id, truck: o.truck })) ctx.refresh(); };
  ctx.actions.delNote = async (noteId) => { if (await deleteNote(noteId)) ctx.refresh(); };

  ctx.refresh = async () => update(await api.get(`/orders/${id}`));
  render();
}
