// Home: the Trucks menu, and the list of orders on one truck.
import { api, qs } from '../api.js';
import { esc, statusPill, startOfToday, COMPANY } from '../ui.js';

const view = document.getElementById('view');

const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);

export async function trucksView(ctx) {
  ctx.chrome('Trucks');
  const render = async () => {
    const data = await api.get(`/trucks${qs({ since: startOfToday() })}`);
    view.innerHTML = `
      ${ctx.server?.storageWarning ? `<div class="banner danger"><b>Data is not being saved.</b> ${esc(ctx.server.storageWarning)}</div>` : ''}
      <div class="truck-grid">
        ${data.trucks.map((t) => `
          <a class="card truck-card ${t.orders ? '' : 'empty-truck'}" href="#/truck/${t.truck}">
            <div class="truck-num">${t.truck}</div>
            <div class="truck-body">
              <strong>Truck ${t.truck}</strong>
              <span class="muted small">Load #${esc(t.load)}</span>
              ${t.orders ? `
                <div class="progress"><span style="width:${pct(t.unitsDone, t.units)}%"></span></div>
                <span class="small">${t.done}/${t.orders} orders done${t.review ? ` · <b class="text-danger">${t.review} to review</b>` : ''}</span>`
                : '<span class="muted small">No orders</span>'}
            </div>
          </a>`).join('')}
      </div>
      ${data.unassigned ? `<a class="card" href="#/truck/none"><strong>${data.unassigned} order${data.unassigned === 1 ? '' : 's'} on an unknown load #</strong><div class="muted small">Ask an admin to check the truck settings.</div></a>` : ''}
      ${ctx.can('management') ? '<div class="toolbar"><a class="btn btn-primary" href="#/orders/new">+ New order</a></div>' : ''}
      <footer class="app-footer">${COMPANY} · Pick Sheets · <span class="pill pill-poc">Proof of concept</span></footer>`;
  };
  ctx.refresh = render;
  await render();
}

export async function truckView(ctx, truck) {
  const known = ctx.trucks.find((t) => String(t.truck) === truck);
  ctx.chrome(known ? `Truck ${truck}` : 'Unknown load #', '#/');
  const render = async () => {
    const orders = await api.get(`/orders${qs({ truck, active: 1, since: startOfToday() })}`);
    const card = (o) => {
      const done = o.units_picked + o.units_out;
      return `
        <a class="card order-card status-${o.status}" href="#/${o.status === 'review' && ctx.can('supervisor') ? 'review' : 'order'}/${o.id}">
          <div class="row">
            <span class="stop">Stop ${esc(o.stop || '—')}</span>
            ${statusPill(o.status)}
          </div>
          <strong class="store">${esc(o.store)}</strong>
          <div class="muted small">${esc([o.address, o.city, o.state].filter(Boolean).join(', '))}</div>
          <div class="progress"><span style="width:${pct(done, o.units)}%"></span></div>
          <div class="row small muted">
            <span>${o.lines_done}/${o.line_count} lines · ${done}/${o.units} cases${o.lines_out ? ` · <b class="text-danger">${o.lines_out} out</b>` : ''}</span>
            <span>${o.picker_name ? esc(o.picker_name) : ''}</span>
          </div>
        </a>`;
    };
    const active = orders.filter((o) => o.status !== 'done');
    const done = orders.filter((o) => o.status === 'done');
    view.innerHTML = `
      ${known ? `<p class="muted small">Load #${esc(known.load)} · ${orders.length} order${orders.length === 1 ? '' : 's'} today</p>` : ''}
      ${active.map(card).join('') || '<div class="empty muted">No orders waiting on this truck.</div>'}
      ${done.length ? `<h2 class="section-title">Finished today (${done.length})</h2>${done.map(card).join('')}` : ''}`;
  };
  ctx.refresh = render;
  await render();
}
