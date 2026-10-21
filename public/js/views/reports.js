// Management reports: every out (shortage), and finished orders with who picked them.
import { api, qs } from '../api.js';
import { esc, fmtTime, fmtNum, downloadCsv, ask } from '../ui.js';
import { dayLists } from './trucks.js';

const view = document.getElementById('view');
const day = (d) => d.toISOString().slice(0, 10);

export async function reportsView(ctx) {
  ctx.chrome('Reports', '#/');
  const today = new Date();
  const weekAgo = new Date(Date.now() - 6 * 86400000);
  let tab = 'outs';
  let rows = [];

  view.innerHTML = `
    <nav class="tabs"><a href="#" data-act="tab" data-arg="outs" class="active">Outs</a><a href="#" data-act="tab" data-arg="orders">Finished orders</a><a href="#" data-act="tab" data-arg="days">Days</a></nav>
    <div class="filters">
      <label>From<input type="date" id="rFrom" value="${day(weekAgo)}"></label>
      <label>To<input type="date" id="rTo" value="${day(today)}"></label>
      <button class="btn btn-ghost" data-act="csv">Download CSV</button>
    </div>
    <div id="report"></div>`;
  const out = document.getElementById('report');
  const range = () => {
    const from = new Date(`${document.getElementById('rFrom').value}T00:00:00`).getTime();
    const to = new Date(`${document.getElementById('rTo').value}T23:59:59`).getTime();
    return { from, to };
  };

  async function render() {
    view.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.arg === tab));
    if (tab === 'days') {
      const { from, to } = range();
      rows = (await api.get('/days')).filter((d) => d.started_at <= to && (d.ended_at ?? Date.now()) >= from);
      out.innerHTML = `
        <p class="muted small">A day ends when every order on every truck is done. Tap a day for its top sellers and outs.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Started</th><th>All trucks loaded</th><th>Orders</th><th>Cases</th><th>Picked</th><th>Out</th><th>Top seller</th></tr></thead>
          <tbody>${rows.map((d) => `<tr class="click" data-act="day" data-arg="${d.id}">
            <td>${fmtTime(d.started_at)}</td><td>${d.ended_at ? fmtTime(d.ended_at) : '<span class="text-warn">in progress</span>'}</td>
            <td class="num">${d.totals.orders}</td><td class="num">${fmtNum(d.totals.cases)}</td><td class="num">${fmtNum(d.totals.picked)}</td>
            <td class="num">${fmtNum(d.totals.outs)}</td><td>${d.topSeller ? `${esc(d.topSeller.description)} (${fmtNum(d.topSeller.cases)})` : ''}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">No days in this period.</td></tr>'}</tbody>
        </table></div>`;
      return;
    }
    rows = await api.get(`/reports/${tab}${qs(range())}`);
    if (tab === 'outs') {
      const units = rows.reduce((s, r) => s + r.out_qty, 0);
      out.innerHTML = `
        <p class="muted small">${rows.length} out line${rows.length === 1 ? '' : 's'} · ${units} total short</p>
        <div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Truck / Stop</th><th>Store</th><th>Item</th><th>Short</th><th>Reason</th><th>Marked by</th><th>Checked by</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${fmtTime(r.out_at)}</td><td>${r.truck ?? '?'} / ${esc(r.stop)}</td><td>${esc(r.store)}</td>
            <td>#${esc(r.code)} ${esc(r.description)}</td><td class="num">${r.out_qty}/${r.qty}</td><td>${esc(r.reason_label)}</td>
            <td>${r.out_reason === 'vip' ? 'VIP sheet' : esc(r.out_by_name || '')}</td>
            <td>${r.out_status === 'confirmed' ? `✓ ${esc(r.reviewed_by_name || '')}` : '<span class="text-warn">not yet</span>'}</td>
          </tr>`).join('') || '<tr><td colspan="8" class="muted">No outs in this period.</td></tr>'}</tbody>
        </table></div>`;
    } else {
      out.innerHTML = `
        <p class="muted small">${rows.length} finished order${rows.length === 1 ? '' : 's'}</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Finished</th><th>Truck / Stop</th><th>Store</th><th>Lines</th><th>Picked</th><th>Out</th><th>Picker</th><th>Approved by</th><th>Pick time</th></tr></thead>
          <tbody>${rows.map((o) => `<tr>
            <td>${fmtTime(o.completed_at)}</td><td>${o.truck ?? '?'} / ${esc(o.stop)}</td><td>${esc(o.store)}</td>
            <td class="num">${o.line_count}</td><td class="num">${o.units_picked}/${o.units}</td><td class="num">${o.units_out || ''}</td>
            <td>${esc(o.picker_name || '')}</td><td>${esc(o.approved_by_name || '')}</td>
            <td>${o.started_at && o.submitted_at ? `${Math.max(1, Math.round((o.submitted_at - o.started_at) / 60000))} min` : ''}</td>
          </tr>`).join('') || '<tr><td colspan="9" class="muted">No finished orders in this period.</td></tr>'}</tbody>
        </table></div>`;
    }
  }

  ctx.actions.tab = (t) => { tab = t; render(); };
  ctx.actions.day = async (id) => {
    const d = await api.get(`/days/${id}`);
    const pick = await ask({
      title: `Day of ${new Date(d.started_at).toLocaleDateString()}`,
      okText: 'Download CSV',
      cancelText: 'Close',
      wide: true,
      body: `<p class="muted small">${fmtNum(d.totals.cases)} cases · ${fmtNum(d.totals.picked)} picked · ${fmtNum(d.totals.outs)} out · ${d.totals.orders} orders
        ${d.ended_at ? ` · all trucks loaded ${fmtTime(d.ended_at)}` : ' · still in progress'}</p>${dayLists(d)}`,
    });
    if (pick) {
      downloadCsv(`day-${new Date(d.started_at).toISOString().slice(0, 10)}.csv`, [
        ['List', 'Rank', 'Code', 'Description', 'Cases', 'Stores'],
        ...d.top.map((r, i) => ['Top seller', i + 1, r.code, r.description, r.cases, r.stores]),
        ...d.mostOut.map((r, i) => ['Most out', i + 1, r.code, r.description, r.cases, r.stores]),
      ]);
    }
  };
  ctx.actions.csv = () => {
    if (tab === 'days') {
      downloadCsv('days.csv', [
        ['Started', 'All trucks loaded', 'Orders', 'Cases', 'Picked', 'Out', 'Top seller', 'Top seller cases'],
        ...rows.map((d) => [new Date(d.started_at).toLocaleString(), d.ended_at ? new Date(d.ended_at).toLocaleString() : 'in progress',
          d.totals.orders, d.totals.cases, d.totals.picked, d.totals.outs, d.topSeller?.description || '', d.topSeller?.cases || '']),
      ]);
      return;
    }
    const stamp = `${document.getElementById('rFrom').value}_to_${document.getElementById('rTo').value}`;
    if (tab === 'outs') {
      downloadCsv(`outs_${stamp}.csv`, [
        ['Marked out', 'Truck', 'Load', 'Stop', 'Store', 'Order date', 'Code', 'Description', 'Ordered', 'Short', 'Reason', 'Marked by', 'Status', 'Checked by'],
        ...rows.map((r) => [new Date(r.out_at || 0).toLocaleString(), r.truck, r.load_no, r.stop, r.store, r.order_date, r.code, r.description,
          r.qty, r.out_qty, r.reason_label, r.out_reason === 'vip' ? 'VIP sheet' : r.out_by_name || '', r.out_status === 'confirmed' ? 'Confirmed' : 'Not checked', r.reviewed_by_name || '']),
      ]);
    } else {
      downloadCsv(`orders_${stamp}.csv`, [
        ['Finished', 'Truck', 'Load', 'Stop', 'Store', 'Order date', 'Lines', 'Ordered', 'Picked', 'Out', 'Picker', 'Approved by', 'Started', 'Submitted'],
        ...rows.map((o) => [new Date(o.completed_at).toLocaleString(), o.truck, o.load_no, o.stop, o.store, o.order_date, o.line_count, o.units,
          o.units_picked, o.units_out, o.picker_name || '', o.approved_by_name || '',
          o.started_at ? new Date(o.started_at).toLocaleString() : '', o.submitted_at ? new Date(o.submitted_at).toLocaleString() : '']),
      ]);
    }
  };
  view.querySelectorAll('input[type=date]').forEach((i) => { i.onchange = render; });
  await render();
}
