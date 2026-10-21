// Home: the Trucks menu, and the list of orders on one truck.
import { api, qs } from '../api.js';
import { esc, statusPill, COMPANY, fmtTime, fmtNum, rateHtml } from '../ui.js';

const view = document.getElementById('view');

const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);

export async function trucksView(ctx) {
  ctx.chrome('Trucks');
  const render = async () => {
    const [data, mine] = await Promise.all([api.get('/trucks'), api.get('/rates').catch(() => null)]);
    const me = mine?.rows.find((r) => r.userId === ctx.user.id);
    view.innerHTML = `
      ${ctx.server?.storageWarning ? `<div class="banner danger"><b>Data is not being saved.</b> ${esc(ctx.server.storageWarning)}</div>` : ''}
      ${dayCard(data.day)}
      ${me ? `<a class="card my-rate" href="#/account"><span class="muted small">Your pick rate today</span>${rateHtml(me.rate, mine.target)}<span class="muted small">${fmtNum(me.cases)} cases</span></a>` : ''}
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
      ${data.day?.ended_at ? dayLists(data.day) : ''}
      <footer class="app-footer">${COMPANY} · Pick Sheets · <span class="pill pill-poc">Proof of concept</span></footer>`;
  };
  ctx.refresh = render;
  await render();
}

// Totals across all trucks for the current work day.
function dayCard(day) {
  if (!day) return '';
  const t = day.totals;
  const done = t.picked + t.outs;
  if (day.ended_at) {
    return `
      <section class="card day-card day-done">
        <div class="row"><strong>✓ All trucks loaded</strong><span class="muted small">${fmtTime(day.ended_at)}</span></div>
        <div class="day-stats">
          <div><b>${fmtNum(t.cases)}</b><span>cases</span></div>
          <div><b>${fmtNum(t.picked)}</b><span>picked</span></div>
          <div><b class="${t.outs ? 'text-danger' : ''}">${fmtNum(t.outs)}</b><span>out</span></div>
          <div><b>${t.orders}</b><span>orders</span></div>
        </div>
        <p class="muted small">The next order entered starts a new day.</p>
      </section>`;
  }
  return `
    <section class="card day-card">
      <div class="row"><strong>All trucks</strong><span class="muted small">Started ${fmtTime(day.started_at)}</span></div>
      <div class="progress"><span style="width:${pct(done, t.cases)}%"></span></div>
      <div class="day-stats">
        <div><b>${fmtNum(t.cases)}</b><span>cases</span></div>
        <div><b>${fmtNum(t.picked)}</b><span>picked</span></div>
        <div><b>${fmtNum(t.left)}</b><span>left</span></div>
        <div><b class="${t.outs ? 'text-danger' : ''}">${fmtNum(t.outs)}</b><span>out</span></div>
      </div>
      <p class="muted small">${t.orders_done} of ${t.orders} orders done</p>
    </section>`;
}

export function itemTable(rows, label) {
  if (!rows?.length) return '<p class="muted small">None.</p>';
  return `<ol class="rank">${rows.map((r) => `
    <li><span class="line-main"><span class="line-name">${esc(r.description)}</span><span class="muted small">#${esc(r.code)} · ${r.stores} store${r.stores === 1 ? '' : 's'}</span></span>
    <b>${fmtNum(r.cases)}</b><small class="muted">&nbsp;${label}</small></li>`).join('')}</ol>`;
}

export function dayLists(day) {
  return `
    <section class="card"><h2>Top sellers</h2>${itemTable(day.top, 'cs')}</section>
    <section class="card"><h2>Most out</h2>${itemTable(day.mostOut, 'cs out')}</section>`;
}

export async function truckView(ctx, truck) {
  const known = ctx.trucks.find((t) => String(t.truck) === truck);
  ctx.chrome(known ? `Truck ${truck}` : 'Unknown load #', '#/');
  const render = async () => {
    const orders = await api.get(`/orders${qs({ truck, active: 1 })}`);
    const card = (o) => {
      const done = o.units_picked + o.units_out;
      return `
        <a class="card order-card status-${o.status}" href="#/${o.status === 'review' && ctx.can('supervisor') ? 'review' : 'order'}/${o.id}">
          <div class="row">
            <span class="stop">Stop ${esc(o.stop || '—')}</span>
            ${statusPill(o.status)}
          </div>
          <strong class="store">${esc(o.store)}${o.is_test ? ' <span class="pill">TEST</span>' : ''}</strong>
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
      ${known ? `<p class="muted small">Load #${esc(known.load)} · ${orders.length} order${orders.length === 1 ? '' : 's'}</p>` : ''}
      ${active.map(card).join('') || '<div class="empty muted">No orders waiting on this truck.</div>'}
      ${done.length ? `<h2 class="section-title">Finished (${done.length})</h2>${done.map(card).join('')}` : ''}`;
  };
  ctx.refresh = render;
  await render();
}
