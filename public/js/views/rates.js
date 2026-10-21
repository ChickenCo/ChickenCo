// Pick rates: cases picked per hour. Supervisors and up see everyone; red means under the target.
import { api, qs } from '../api.js';
import { esc, toast, ask, rateHtml, fmtDuration, fmtNum, downloadCsv } from '../ui.js';

const view = document.getElementById('view');

export async function ratesView(ctx) {
  ctx.chrome('Pick rates', '#/');
  let period = 'day';
  let data = null;

  async function render() {
    data = await api.get(`/rates${qs({ period })}`);
    view.innerHTML = `
      <nav class="tabs">
        <a href="#" data-act="period" data-arg="day" class="${period === 'day' ? 'active' : ''}">Today</a>
        <a href="#" data-act="period" data-arg="week" class="${period === 'week' ? 'active' : ''}">Last 7 days</a>
      </nav>
      <div class="row small rate-target">
        <span>Below <b>${fmtNum(data.target)} cases/hr</b> shows in <span class="rate-low">red</span>.</span>
        <button class="btn btn-small btn-ghost" data-act="settings">Change</button>
      </div>
      ${data.rows.length ? `
        <ul class="lines">${data.rows.map((r) => `
          <li class="line rate-row">
            <span class="line-main">
              <span class="line-name">${esc(r.name)}</span>
              <span class="muted small">${fmtNum(r.cases)} cases · ${r.orders} order${r.orders === 1 ? '' : 's'} · ${fmtDuration(r.activeMs)} picking</span>
              <span class="muted small">${r.outs} marked out${r.foundOnShelf ? ` · <b class="text-warn">${r.foundOnShelf} found on shelf</b>` : ''}</span>
            </span>
            ${rateHtml(r.rate, data.target)}
          </li>`).join('')}</ul>
        <div class="toolbar"><button class="btn btn-ghost" data-act="csv">Download CSV</button></div>`
        : '<div class="empty muted">No picking yet for this period.</div>'}
      <p class="muted small">Only time spent picking counts: from <b>Start picking</b> until the order is finished or put down. A gap of more than 10 minutes between scans counts as 10 minutes, so breaks don't lower anyone's rate. "Found on shelf" means a supervisor found an item the picker had marked out.</p>
      <p class="muted small">Test and demo orders are ${data.includeTests ? '<b>included</b>' : 'left out'}.</p>`;
  }

  ctx.actions.period = (p) => { period = p; render(); };
  ctx.actions.settings = async () => {
    const saved = await ask({
      title: 'Pick rate settings',
      okText: 'Save',
      body: `
        <label>Show in red below (cases per hour)<input name="min" type="number" inputmode="numeric" min="1" value="${data.target}"></label>
        <label class="radio"><input type="checkbox" name="tests" ${data.includeTests ? 'checked' : ''}> Count test and demo orders</label>
        <p class="muted small">Leave this on while trying the app out. Turn it off once real orders start so practice doesn't change anyone's numbers.</p>`,
      onOk: (f) => api.put('/settings/pick-rate', { min: f.elements.min.value, includeTests: f.elements.tests.checked }),
    });
    if (saved) { toast('Saved', 'ok'); render(); }
  };
  ctx.actions.csv = () => downloadCsv(`pick-rates-${period}.csv`, [
    ['Employee', 'Cases', 'Orders', 'Minutes picking', 'Cases per hour', 'Below target', 'Marked out', 'Found on shelf'],
    ...data.rows.map((r) => [r.name, r.cases, r.orders, Math.round(r.activeMs / 60000), r.rate ?? '', r.rate != null && r.rate < data.target ? 'yes' : '', r.outs, r.foundOnShelf]),
  ]);

  ctx.refresh = render;
  await render();
}

// "My pick rate" card on the account page.
export async function myRateHtml(ctx) {
  const [day, week] = await Promise.all([api.get('/rates?period=day'), api.get('/rates?period=week')]);
  const mine = (d) => d.rows.find((r) => r.userId === ctx.user.id);
  const block = (label, d) => {
    const r = mine(d);
    return `<div class="my-rate-block"><span class="muted small">${label}</span>
      ${r ? `${rateHtml(r.rate, d.target, { big: true })}<span class="muted small">${fmtNum(r.cases)} cases · ${fmtDuration(r.activeMs)} picking${r.foundOnShelf ? ` · ${r.foundOnShelf} found on shelf` : ''}</span>` : '<span class="muted">No picking yet</span>'}</div>`;
  };
  return `
    <section class="card">
      <h2>My pick rate</h2>
      <div class="my-rate-grid">${block('Today', day)}${block('Last 7 days', week)}</div>
      <p class="muted small">Target: ${fmtNum(day.target)} cases/hr. Only time spent picking counts.</p>
    </section>`;
}
