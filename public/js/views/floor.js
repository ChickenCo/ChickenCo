// Supervisor: who is picking what right now, who has gone quiet, and items running out repeatedly.
import { api } from '../api.js';
import { esc, fmtTime, fmtNum, rateHtml } from '../ui.js';

const view = document.getElementById('view');
const IDLE_MIN = 10;

function ago(ms) {
  if (!ms) return 'nothing yet today';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return fmtTime(ms);
}

export async function floorView(ctx) {
  ctx.chrome('Floor', '#/');
  const render = async () => {
    const f = await api.get('/floor');
    if (!f.day) { view.innerHTML = '<div class="empty muted">No orders yet.</div>'; return; }
    const picking = f.people.filter((p) => p.order);
    const free = f.people.filter((p) => !p.order);
    const idle = (p) => p.order && p.lastAt && Date.now() - p.lastAt > IDLE_MIN * 60000;
    const person = (p) => `
      <li class="line floor-row ${idle(p) ? 'idle' : ''}">
        <span class="line-main">
          <span class="line-name">${esc(p.name)}</span>
          ${p.order ? `<a class="small" href="#/order/${p.order.id}">Truck ${p.order.truck ?? '?'} · Stop ${esc(p.order.stop)} · ${esc(p.order.store)}</a>
            <span class="progress"><span style="width:${p.order.units ? Math.round((p.order.done / p.order.units) * 100) : 0}%"></span></span>
            <span class="muted small">${p.order.done}/${p.order.units} cases${p.order.others ? ` · also holding ${p.order.others} other order${p.order.others === 1 ? '' : 's'}` : ''}</span>`
            : '<span class="muted small">Not on an order</span>'}
          <span class="small ${idle(p) ? 'text-warn' : 'muted'}">Last scan ${ago(p.lastAt)}${idle(p) ? ` · no scans for ${IDLE_MIN}+ min` : ''}</span>
        </span>
        <span class="floor-rate">${p.cases ? rateHtml(p.rate, f.target) : ''}</span>
      </li>`;
    view.innerHTML = `
      ${f.repeatOuts.length ? `<section class="card banner-card danger">
        <h2>Running out today</h2>
        <ul class="plain">${f.repeatOuts.map((r) => `<li><b>${esc(r.description || r.code)}</b> <span class="muted small">#${esc(r.code)}</span> · out on <b>${r.orders}</b> orders</li>`).join('')}</ul>
        <p class="muted small">Marked out on several orders today. Worth checking stock before more orders hit it.</p>
      </section>` : ''}
      <div class="floor-trucks">${f.trucks.map((t) => `
        <a class="card floor-truck" href="#/truck/${t.truck}">
          <b>Truck ${t.truck}</b>
          <span class="small">${t.open} waiting · ${t.picking} picking</span>
          <span class="small">${t.done} done${t.review ? ` · <b class="text-danger">${t.review} review</b>` : ''}</span>
        </a>`).join('')}</div>
      <h2 class="section-title">Picking now (${picking.length})</h2>
      <ul class="lines">${picking.map(person).join('') || '<li class="empty muted">Nobody is on an order.</li>'}</ul>
      ${free.length ? `<h2 class="section-title">Not on an order (${free.length})</h2><ul class="lines">${free.map(person).join('')}</ul>` : ''}
      <p class="muted small">Updates on its own every few seconds. Highlighted: no scans for ${IDLE_MIN} minutes or more while holding an order.</p>`;
  };
  ctx.refresh = render;
  await render();
  // Refresh "x min ago" even when nothing else changes.
  const tick = setInterval(() => { if (location.hash !== '#/floor') clearInterval(tick); else render().catch(() => {}); }, 30000);
}
