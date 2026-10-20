// Picking one order: scan barcodes, enter quantities, mark items out, finish.
import { api, qs } from '../api.js';
import * as Scanner from '../scanner.js';
import { esc, toast, feedback, ask, askQty, choose, confirmBox, statusPill, fmtTime, UNIT_SHORT, OUT_REASONS } from '../ui.js';

const view = document.getElementById('view');

export function orderHeader(o, ctx) {
  return `
    <section class="card order-head">
      <div class="row"><strong class="store">${esc(o.store)}</strong>${statusPill(o.status)}</div>
      <div class="muted small">${esc([o.address, o.city, o.state].filter(Boolean).join(', '))}</div>
      <div class="facts">
        <span><b>${esc(ctx.truckName(o.truck))}</b> · Load #${esc(o.load_no)}</span>
        <span>Stop <b>${esc(o.stop || '—')}</b></span>
        ${o.day_no ? `<span>Day ${esc(o.day_no)}</span>` : ''}
        ${o.order_date ? `<span>${esc(o.order_date)}</span>` : ''}
        ${o.zone ? `<span>Zone ${esc(o.zone)}</span>` : ''}
        ${o.account_no ? `<span>Acct ${esc(o.account_no)}</span>` : ''}
      </div>
    </section>`;
}

export function lineRow(l, { act = 'line' } = {}) {
  const done = l.picked + l.out_qty >= l.qty;
  const out = l.out_qty > 0;
  const cls = out ? 'out' : done ? 'done' : l.picked ? 'partial' : '';
  return `
    <li class="line ${cls}" ${act ? `data-act="${act}" data-arg="${l.id}"` : ''}>
      <span class="check" aria-hidden="true">${out ? '!' : done ? '✓' : ''}</span>
      <span class="line-main">
        <span class="line-name">${esc(l.description)}</span>
        <span class="muted small">#${esc(l.code)}${out ? ` · <b class="text-danger">OUT ${l.out_qty}${l.out_qty < l.qty ? ` of ${l.qty}` : ''} – ${esc(OUT_REASONS[l.out_reason] || '')}</b>${l.out_status === 'confirmed' ? ' ✓ confirmed' : ''}` : ''}</span>
      </span>
      <span class="qty">${l.picked}<small>/${l.qty} ${UNIT_SHORT[l.unit] || ''}</small></span>
    </li>`;
}

export async function pickView(ctx, id) {
  let o = await api.get(`/orders/${id}`);
  const mine = () => o.status === 'picking' && o.picker_id === ctx.user.id;
  const canPick = () => mine() || (ctx.can('supervisor') && o.status === 'picking');
  const remainingToPick = (l) => l.qty - l.picked;

  function render() {
    ctx.chrome(`Stop ${o.stop || '—'}`, o.truck ? `#/truck/${o.truck}` : '#/');
    const todo = o.lines.filter((l) => l.picked + l.out_qty < l.qty);
    const outs = o.lines.filter((l) => l.out_qty > 0);
    const done = o.lines.filter((l) => l.picked >= l.qty);
    const totalUnits = o.lines.reduce((s, l) => s + l.qty, 0);
    const pickedUnits = o.lines.reduce((s, l) => s + l.picked, 0);
    const ready = todo.length === 0;
    const act = canPick() ? 'line' : '';

    let banner = '';
    if (o.status === 'open') banner = '<div class="banner">Tap <b>Start picking</b> to take this order.</div>';
    else if (o.status === 'picking' && !mine()) banner = `<div class="banner warn">${esc(o.picker_name)} is picking this order${o.started_at ? ` (started ${fmtTime(o.started_at)})` : ''}.</div>`;
    else if (o.status === 'review') banner = '<div class="banner warn">Sent to a supervisor to check the outs.</div>';
    else if (o.status === 'done') banner = `<div class="banner ok">Order complete${o.completed_at ? ` · ${fmtTime(o.completed_at)}` : ''}${o.picker_name ? ` · picked by ${esc(o.picker_name)}` : ''}</div>`;
    else if (ready) banner = `<div class="banner ok">Everything is picked or marked out. ${outs.length ? 'Send it to a supervisor to check the outs.' : 'Finish the order.'}</div>`;

    let bar = '';
    if (o.status === 'open' || (o.status === 'picking' && !mine() && ctx.can('supervisor'))) {
      bar = `<button class="btn btn-primary btn-scan" data-act="start">${o.status === 'open' ? 'Start picking' : 'Take over this order'}</button>`;
    } else if (canPick()) {
      bar = ready
        ? `<button class="btn btn-ghost" data-act="more">⋯</button>
           <button class="btn btn-primary btn-scan" data-act="submit">${outs.length ? `Send to supervisor (${outs.length} out)` : 'Finish order'}</button>`
        : `<button class="btn btn-ghost" data-act="more">⋯</button>
           <button class="btn btn-ghost" data-act="type">Type code</button>
           <button class="btn btn-primary btn-scan" data-act="scan">Scan</button>`;
    }

    view.innerHTML = `
      ${orderHeader(o, ctx)}
      <section class="card summary">
        <div class="progress big"><span style="width:${totalUnits ? Math.round(((pickedUnits + outs.reduce((s, l) => s + l.out_qty, 0)) / totalUnits) * 100) : 0}%"></span></div>
        <div class="row small"><span>${o.lines.length - todo.length} of ${o.lines.length} lines</span><span>${pickedUnits} of ${totalUnits} picked</span></div>
      </section>
      ${banner}
      ${todo.length ? `<h2 class="section-title">To pick (${todo.length})</h2><ul class="lines">${todo.map((l) => lineRow(l, { act })).join('')}</ul>` : ''}
      ${outs.length ? `<h2 class="section-title">Out (${outs.length})</h2><ul class="lines">${outs.map((l) => lineRow(l, { act })).join('')}</ul>` : ''}
      ${done.length ? `<h2 class="section-title">Picked (${done.length})</h2><ul class="lines">${done.filter((l) => !l.out_qty).map((l) => lineRow(l, { act })).join('')}</ul>` : ''}
      ${canPick() ? '<p class="muted small center">Tap an item to change its quantity or mark it out.</p>' : ''}
      ${bar ? `<div class="bottom-bar">${bar}</div>` : ''}`;
  }

  const update = (fresh) => { o = fresh; render(); };

  async function pickQty(line) {
    const max = remainingToPick(line);
    const open = line.qty - line.picked - line.out_qty;
    if (line.qty === 1 && max === 1) return 1;
    return askQty({
      title: line.description,
      subtitle: `#${esc(line.code)} · ${line.picked} of ${line.qty} ${esc(UNIT_SHORT[line.unit] || '')} picked.${line.out_qty ? ' <b>This item is marked out</b>; picking it clears the out.' : ''} How many did you just pick?`,
      value: open > 0 ? open : max,
      min: 1,
      max,
      okText: 'Add',
    });
  }

  // Shared by the camera and "Type code".
  async function handleBarcode(raw, format, fromCamera) {
    const say = (msg, kind) => (fromCamera ? Scanner.setStatus(msg, kind) : toast(msg, kind === 'error' ? 'error' : 'ok'));
    let found;
    try { found = await api.get(`/barcodes/lookup${qs({ raw, format })}`); } catch (err) { say(err.message, 'error'); return; }

    // Typed item codes (e.g. 00439) work too.
    let line = found.item
      ? o.lines.find((l) => l.code === found.item.code)
      : o.lines.find((l) => l.code === String(raw).trim().toUpperCase());

    if (!found.item && !line) {
      feedback('error');
      line = await linkUnknown(found, raw, format);
      if (!line) { say('Barcode not linked'); return; }
    } else if (!line) {
      feedback('error');
      say(`NOT ON THIS ORDER: ${found.item.description} (#${found.item.code}). No substitutions.`, 'error');
      return;
    }
    if (remainingToPick(line) <= 0) {
      feedback('error');
      say(`${line.description} is already fully picked`, 'error');
      return;
    }
    feedback('ok');
    const n = await pickQty(line);
    if (!n) { say('Line up the barcode inside the box'); return; }
    try {
      update(await api.post(`/orders/${o.id}/lines/${line.id}/pick`, { picked: line.picked + n, via: fromCamera ? 'scan' : 'typed' }));
      const fresh = o.lines.find((l) => l.id === line.id);
      say(`✓ ${fresh.description}: ${fresh.picked}/${fresh.qty}`, 'ok');
      if (o.lines.every((l) => l.picked + l.out_qty >= l.qty)) {
        if (fromCamera) setTimeout(() => Scanner.close(), 800);
        toast('All items are picked or marked out', 'ok');
      }
    } catch (err) { say(err.message, 'error'); }
  }

  // Unknown barcode: let the picker say which line it is. Saved as "pending" for a supervisor to check.
  async function linkUnknown(found, raw, format) {
    const open = o.lines.filter((l) => remainingToPick(l) > 0);
    const key = await choose('New barcode', [
      ...open.map((l) => ({ key: String(l.id), html: `<span class="choice-main">${esc(l.description)}</span><span class="muted small">#${esc(l.code)}</span>` })),
      { key: 'none', label: "It's not on this order", danger: true },
    ], `Barcode <b>${esc(found.display)}</b> isn't linked to an item yet. Which item on this order did you scan? A supervisor will double-check it.`);
    if (!key || key === 'none') return null;
    const line = o.lines.find((l) => String(l.id) === key);
    try {
      await api.post('/barcodes', { raw, format, code: line.code });
      toast(`Barcode linked to ${line.description}`, 'ok');
    } catch (err) { toast(err.message, 'error'); return null; }
    return line;
  }

  async function typeCode(fromCamera) {
    const code = await ask({
      title: 'Type a code',
      okText: 'Find',
      body: `<label>Item # or barcode number<input name="code" inputmode="numeric" autocomplete="off" autocapitalize="characters"></label>
             <p class="muted small">Use the item # from the sheet (like 00439) or the numbers under the barcode.</p>`,
      onOk: (f) => { const v = f.elements.code.value.trim(); if (!v) throw new Error('Enter a code'); return v; },
    });
    if (code) await handleBarcode(code, '', fromCamera);
  }

  async function markOut(line) {
    const max = line.qty - line.picked;
    const res = await askQty({
      title: `Mark out: ${line.description}`,
      subtitle: `#${esc(line.code)} · ${line.picked} of ${line.qty} picked. How many are you short?`,
      value: max, min: 1, max, okText: 'Mark out',
      extra: `<div class="reason-pick"><label class="radio"><input type="radio" name="reason" value="out_of_stock" checked> Out of stock</label>
              <label class="radio"><input type="radio" name="reason" value="cant_find"> Can't find</label></div>`,
      read: (form, qty) => ({ qty, reason: form.elements.reason.value }),
    });
    if (!res) return;
    try { update(await api.post(`/orders/${o.id}/lines/${line.id}/out`, res)); toast('Marked out'); } catch (err) { toast(err.message, 'error'); }
  }

  ctx.actions.line = async (lineId) => {
    const line = o.lines.find((l) => String(l.id) === lineId);
    const options = [
      remainingToPick(line) > 0 && { key: 'add', label: 'Add picked quantity', primary: true },
      { key: 'set', label: 'Set picked quantity' },
      line.qty - line.picked > 0 && !line.out_qty && { key: 'out', label: 'Mark out…', danger: true },
      line.out_qty && line.out_reason !== 'vip' && { key: 'out', label: 'Change out quantity…' },
      line.out_qty && { key: 'clear', label: 'Clear the out' },
    ].filter(Boolean);
    const pick = await choose(line.description, options, `#${esc(line.code)} · ${line.picked} of ${line.qty} ${esc(UNIT_SHORT[line.unit] || '')} picked`);
    try {
      if (pick === 'add') {
        const n = await pickQty(line);
        if (n) update(await api.post(`/orders/${o.id}/lines/${line.id}/pick`, { picked: line.picked + n, via: 'manual' }));
      } else if (pick === 'set') {
        const n = await askQty({ title: line.description, subtitle: `Total picked (needed: ${line.qty})`, value: line.picked, min: 0, max: line.qty, okText: 'Save' });
        if (n !== null) update(await api.post(`/orders/${o.id}/lines/${line.id}/pick`, { picked: n, via: 'manual' }));
      } else if (pick === 'out') {
        await markOut(line);
      } else if (pick === 'clear') {
        update(await api.post(`/orders/${o.id}/lines/${line.id}/clear-out`));
      }
    } catch (err) { toast(err.message, 'error'); }
  };

  ctx.actions.start = async () => {
    try { update(await api.post(`/orders/${o.id}/start`)); toast('Order is yours. Start scanning.', 'ok'); } catch (err) { toast(err.message, 'error'); }
  };
  ctx.actions.scan = () => Scanner.open((text, format) => handleBarcode(text, format, true), () => typeCode(true));
  ctx.actions.type = () => typeCode(false);
  ctx.actions.more = async () => {
    const pick = await choose('Order options', [
      { key: 'release', label: 'Stop picking (let someone else take it)' },
    ]);
    if (pick === 'release' && await confirmBox('Stop picking?', 'Your progress is kept. The order goes back to "Not started" so anyone can pick it up.', 'Stop picking')) {
      try { update(await api.post(`/orders/${o.id}/release`)); } catch (err) { toast(err.message, 'error'); }
    }
  };
  ctx.actions.submit = async () => {
    const outs = o.lines.filter((l) => l.out_qty > 0);
    const ok = outs.length
      ? await confirmBox('Send to supervisor?', `${outs.length} item${outs.length === 1 ? ' is' : 's are'} marked out. A supervisor will be notified to double-check before the order is finished.`, 'Send')
      : await confirmBox('Finish order?', 'Every item is picked.', 'Finish');
    if (!ok) return;
    try {
      update(await api.post(`/orders/${o.id}/submit`));
      toast(o.status === 'done' ? 'Order finished' : 'Sent to supervisor', 'ok');
      location.hash = o.truck ? `#/truck/${o.truck}` : '#/';
    } catch (err) { toast(err.message, 'error'); }
  };

  ctx.refresh = async () => update(await api.get(`/orders/${id}`));
  render();
}
