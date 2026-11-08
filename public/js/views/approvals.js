// Supervisors: picks a picker wants to add without scanning. Approve adds them; deny tells the picker to scan.
import { api } from '../api.js';
import { esc, toast, fmtTime, stopLabel, UNIT_SHORT } from '../ui.js';

const view = document.getElementById('view');

export async function approvalsView(ctx) {
  ctx.chrome('Picks to OK', '#/');
  const render = async () => {
    const rows = await api.get('/approvals');
    ctx.counts.approvals = rows.length;
    view.innerHTML = `
      <p class="muted small">Pickers have to scan items to add them. These are picks they asked to add without a scan. Approve only if you know they have the item.</p>
      ${rows.map((r) => `
        <section class="card approval">
          <div class="row"><b>${esc(r.description)}</b><span class="muted small">#${esc(r.code)}</span></div>
          <p>Add <b>${r.to_qty - r.from_qty} ${esc(UNIT_SHORT[r.unit] || '')}</b> · now ${r.picked} of ${r.qty} picked</p>
          <p class="muted small">${esc(r.picker_name || 'Someone')} · Truck ${r.truck ?? '?'} · ${esc(stopLabel(r))} · ${esc(r.store)} · asked ${fmtTime(r.created_at)}</p>
          <div class="toolbar">
            <button class="btn btn-ghost btn-danger-text" data-act="deny" data-arg="${r.id}">Deny</button>
            <a class="btn btn-ghost" href="#/order/${r.order_id}">Open order</a>
            <button class="btn btn-primary" data-act="approve" data-arg="${r.id}">Approve</button>
          </div>
        </section>`).join('') || '<div class="empty muted">Nothing waiting for your OK.</div>'}`;
  };
  const decide = (yes) => async (id) => {
    try {
      await api.post(`/approvals/${id}/${yes ? 'approve' : 'deny'}`);
      toast(yes ? 'Approved and added' : 'Denied. The picker is told to scan it.', yes ? 'ok' : '');
    } catch (err) { toast(err.message, 'error'); }
    await render();
  };
  ctx.actions.approve = decide(true);
  ctx.actions.deny = decide(false);
  ctx.refresh = render;
  await render();
}
