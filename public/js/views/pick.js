// Picking one order: scan barcodes, enter quantities, mark items out, finish.
// Keeps working with no signal: changes are saved on the phone and sent when it reconnects.
import { api, qs } from '../api.js';
import * as Scanner from '../scanner.js';
import { normalizeBarcode } from '../barcode.js';
import { notesHtml, addNote, deleteNote } from '../notes.js';
import * as Wedge from '../wedge.js';
import { esc, toast, feedback, ask, askQty, choose, confirmBox, statusPill, fmtTime, modalOpen, UNIT_SHORT, OUT_REASONS } from '../ui.js';

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

// ---------- saved-on-phone storage ----------
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ } },
};

const PATHS = { pick: 'pick', out: 'out', clear: 'clear-out' };

// Mirror of the server's rules, so the screen updates right away while offline.
function applyLocal(o, { kind, lineId, body }) {
  const l = o.lines.find((x) => x.id === lineId);
  if (!l) return;
  if (kind === 'pick') {
    l.picked = body.picked;
    l.out_qty = Math.min(l.out_qty, l.qty - l.picked);
    if (!l.out_qty) { l.out_reason = null; l.out_status = null; }
  } else if (kind === 'out') {
    Object.assign(l, { out_qty: body.qty, out_reason: body.reason, out_status: 'pending' });
  } else if (kind === 'clear') {
    Object.assign(l, { out_qty: 0, out_reason: null, out_status: null });
  }
}

let flushTimer = null;

export async function pickView(ctx, id) {
  const qKey = `pick-queue:${id}`;
  const oKey = `pick-order:${id}`;
  let queue = store.get(qKey, []);
  let o;
  try {
    o = await api.get(`/orders/${id}`);
    store.set(oKey, o);
  } catch (err) {
    o = store.get(oKey, null);
    if (err.status !== 0 || !o) throw err;
    toast('No signal. Showing the copy saved on this phone.');
  }
  queue.forEach((op) => applyLocal(o, op));
  let codes = new Map(store.get(`pick-codes:${id}`, []));
  api.get(`/orders/${id}/barcodes`).then((rows) => {
    codes = new Map(rows.map((r) => [r.gtin, r.code]));
    store.set(`pick-codes:${id}`, [...codes]);
  }).catch(() => {});

  const undoStack = [];
  let search = '';
  let big = store.get('pick-big-view', false);
  let bigIdx = 0;

  const mine = () => o.status === 'picking' && o.picker_id === ctx.user.id;
  const canPick = () => ctx.can('picker') && (mine() || (ctx.can('supervisor') && o.status === 'picking'));
  const remainingToPick = (l) => l.qty - l.picked;
  const lineById = (lid) => o.lines.find((l) => String(l.id) === String(lid));
  const todoLines = () => o.lines.filter((l) => l.picked + l.out_qty < l.qty);

  function render() {
    ctx.chrome(`Stop ${o.stop || '—'}`, o.truck ? `#/truck/${o.truck}` : '#/');
    const todo = todoLines();
    const outs = o.lines.filter((l) => l.out_qty > 0);
    const totalUnits = o.lines.reduce((s, l) => s + l.qty, 0);
    const pickedUnits = o.lines.reduce((s, l) => s + l.picked, 0);
    const ready = todo.length === 0;

    let banner = '';
    if (queue.length) banner = `<div class="banner warn">No signal. ${queue.length} change${queue.length === 1 ? ' is' : 's are'} saved on this phone and will send when you're back in range.</div>`;
    if (o.status === 'open') banner += ctx.can('picker') ? '<div class="banner">Tap <b>Start picking</b> to take this order.</div>' : '';
    else if (o.status === 'picking' && !mine()) banner += `<div class="banner warn">${esc(o.picker_name)} is picking this order${o.started_at ? ` (started ${fmtTime(o.started_at)})` : ''}.</div>`;
    else if (o.status === 'review') banner += '<div class="banner warn">Sent to a supervisor to check the outs.</div>';
    else if (o.status === 'done') banner += `<div class="banner ok">Order complete${o.completed_at ? ` · ${fmtTime(o.completed_at)}` : ''}${o.picker_name ? ` · picked by ${esc(o.picker_name)}` : ''}</div>`;
    else if (ready) banner += `<div class="banner ok">Everything is picked or marked out. ${outs.length ? 'Send it to a supervisor to check the outs.' : 'Finish the order.'}</div>`;

    let bar = '';
    const undo = canPick() && undoStack.length ? '<button class="btn btn-ghost btn-undo" data-act="undo" aria-label="Undo last change">↶ Undo</button>' : '';
    if (ctx.can('picker') && (o.status === 'open' || (o.status === 'picking' && !mine() && ctx.can('supervisor')))) {
      bar = `<button class="btn btn-primary btn-scan" data-act="start">${o.status === 'open' ? 'Start picking' : 'Take over this order'}</button>`;
    } else if (canPick()) {
      bar = ready
        ? `<button class="btn btn-ghost" data-act="more">⋯</button>${undo}
           <button class="btn btn-primary btn-scan" data-act="submit">${outs.length ? `Send to supervisor (${outs.length} out)` : 'Finish order'}</button>`
        : `<button class="btn btn-ghost" data-act="more">⋯</button>${undo}
           <button class="btn btn-ghost" data-act="type">Type code</button>
           <button class="btn btn-primary btn-scan" data-act="scan">Scan</button>`;
    }

    view.innerHTML = `
      ${orderHeader(o, ctx)}
      ${notesHtml(o.notes, ctx, { addArg: 'order' })}
      <section class="card summary">
        <div class="progress big"><span style="width:${totalUnits ? Math.round(((pickedUnits + outs.reduce((s, l) => s + l.out_qty, 0)) / totalUnits) * 100) : 0}%"></span></div>
        <div class="row small"><span>${o.lines.length - todo.length} of ${o.lines.length} lines</span><span>${pickedUnits} of ${totalUnits} picked</span></div>
      </section>
      ${banner}
      ${canPick() && !ready ? `<div class="view-toggle">
        <button class="btn btn-small ${big ? 'btn-ghost' : 'btn-primary'}" data-act="bigOff">List</button>
        <button class="btn btn-small ${big ? 'btn-primary' : 'btn-ghost'}" data-act="bigOn">Big text</button></div>` : ''}
      ${big && canPick() && !ready ? '' : `<input class="search" type="search" id="lineSearch" placeholder="Find on this order: name or item #" value="${esc(search)}" autocomplete="off">`}
      ${canPick() ? '<p class="scanner-chip" id="scannerChip"></p>' : ''}
      <div id="pickLists"></div>
      ${bar ? `<div class="bottom-bar">${bar}</div>` : ''}`;
    renderScannerChip();
    const input = document.getElementById('lineSearch');
    if (input) input.oninput = () => { search = input.value.trim().toLowerCase(); renderLists(); };
    renderLists();
  }

  function renderScannerChip() {
    const chip = document.getElementById('scannerChip');
    if (!chip) return;
    let seen = 0;
    try { seen = Number(localStorage.getItem('wedge-seen')) || 0; } catch { /* ignore */ }
    chip.innerHTML = Date.now() - seen < 12 * 3600000
      ? '<span class="dot-ok"></span> Ring scanner ready. Just scan; no need to tap anything.'
      : 'Using a ring scanner? Just scan. No need to tap Scan.';
  }

  function renderLists() {
    const wrap = document.getElementById('pickLists');
    if (!wrap) return;
    const act = canPick() ? 'line' : '';
    const todo = todoLines();
    if (big && canPick() && todo.length) {
      bigIdx = Math.min(bigIdx, todo.length - 1);
      const l = todo[bigIdx];
      wrap.innerHTML = `
        <section class="card big-item ${l.out_qty ? 'out' : ''}">
          <div class="muted">Item ${bigIdx + 1} of ${todo.length} left</div>
          <div class="big-name">${esc(l.description)}</div>
          <div class="big-code">#${esc(l.code)}</div>
          <div class="big-qty"><b>${remainingToPick(l) - l.out_qty}</b> <span>${esc(UNIT_SHORT[l.unit] || '')} to pick</span></div>
          <div class="muted">${l.picked} of ${l.qty} picked${l.out_qty ? ` · <b class="text-danger">OUT ${l.out_qty}</b>` : ''}</div>
          <div class="big-actions">
            <button class="btn btn-primary" data-act="bigAll" data-arg="${l.id}">✓ Picked all</button>
            <button class="btn btn-ghost" data-act="line" data-arg="${l.id}">Other…</button>
          </div>
          <div class="big-nav">
            <button class="btn btn-ghost" data-act="bigPrev" ${bigIdx ? '' : 'disabled'}>‹ Back</button>
            <button class="btn btn-ghost" data-act="bigNext" ${bigIdx < todo.length - 1 ? '' : 'disabled'}>Skip ›</button>
          </div>
        </section>`;
      return;
    }
    const match = (l) => !search || l.description.toLowerCase().includes(search) || l.code.toLowerCase().includes(search);
    const shownTodo = todo.filter(match);
    const outs = o.lines.filter((l) => l.out_qty > 0 && match(l));
    const done = o.lines.filter((l) => l.picked >= l.qty && !l.out_qty && match(l));
    wrap.innerHTML = `
      ${shownTodo.length ? `<h2 class="section-title">To pick (${shownTodo.length})</h2><ul class="lines">${shownTodo.map((l) => lineRow(l, { act })).join('')}</ul>` : ''}
      ${outs.length ? `<h2 class="section-title">Out (${outs.length})</h2><ul class="lines">${outs.map((l) => lineRow(l, { act })).join('')}</ul>` : ''}
      ${done.length ? `<h2 class="section-title">Picked (${done.length})</h2><ul class="lines">${done.map((l) => lineRow(l, { act })).join('')}</ul>` : ''}
      ${search && !shownTodo.length && !outs.length && !done.length ? '<p class="muted center">Nothing on this order matches.</p>' : ''}
      ${canPick() ? '<p class="muted small center">Tap an item to change its quantity or mark it out.</p>' : ''}`;
  }

  const update = (fresh) => {
    o = fresh;
    queue.forEach((op) => applyLocal(o, op));
    store.set(oKey, fresh);
    render();
  };

  // ---------- sending changes (or saving them for later) ----------
  async function send(kind, line, body, label) {
    const before = { picked: line.picked, out_qty: line.out_qty, out_reason: line.out_reason };
    const op = { kind, lineId: line.id, body: { ...body, at: Date.now() } };
    if (label) undoStack.push({ lineId: line.id, before, label });
    if (!queue.length) {
      try {
        update(await api.post(`/orders/${o.id}/lines/${line.id}/${PATHS[kind]}`, op.body));
        return true;
      } catch (err) {
        if (err.status !== 0) { if (label) undoStack.pop(); throw err; }
      }
    }
    queue.push(op);
    store.set(qKey, queue);
    applyLocal(o, op);
    render();
    scheduleFlush();
    return true;
  }

  async function flush() {
    while (queue.length) {
      const op = queue[0];
      try {
        const fresh = await api.post(`/orders/${o.id}/lines/${op.lineId}/${PATHS[op.kind]}`, op.body);
        queue.shift();
        store.set(qKey, queue);
        if (!queue.length) { update(fresh); toast('Back online. Saved changes were sent.', 'ok'); }
      } catch (err) {
        if (err.status === 0) return; // still offline
        queue.shift(); // the server refused it (e.g. a supervisor changed the order); drop it
        store.set(qKey, queue);
        toast(`A saved change couldn't be sent: ${err.message}`, 'error');
      }
    }
    try { update(await api.get(`/orders/${o.id}`)); } catch { /* next time */ }
  }

  function scheduleFlush() {
    clearInterval(flushTimer);
    flushTimer = setInterval(() => {
      if (!location.hash.startsWith(`#/order/${id}`)) { clearInterval(flushTimer); return; }
      if (queue.length) flush(); else clearInterval(flushTimer);
    }, 5000);
  }
  window.ononline = () => { if (queue.length && location.hash.startsWith(`#/order/${id}`)) flush(); };
  if (queue.length) scheduleFlush();

  async function undo() {
    const last = undoStack.pop();
    if (!last) return;
    const b = last.before;
    try {
      await send('pick', lineById(last.lineId), { picked: b.picked, via: 'undo' });
      const now = lineById(last.lineId); // fresh copy after the first step
      if (b.out_qty && (now.out_qty !== b.out_qty || now.out_reason !== b.out_reason)) {
        await send('out', now, { qty: b.out_qty, reason: b.out_reason, undo: true });
      } else if (!b.out_qty && now.out_qty) {
        await send('clear', now, {});
      }
      toast(`Undone: ${last.label}`);
    } catch (err) { toast(err.message, 'error'); }
  }

  // ---------- picking ----------
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

  async function lookup(raw, format) {
    try {
      return await api.get(`/barcodes/lookup${qs({ raw, format })}`);
    } catch (err) {
      if (err.status !== 0) throw err;
      // No signal: match against this order's barcodes saved on the phone.
      const gtin = normalizeBarcode(raw, format);
      const code = codes.get(gtin);
      const line = code && o.lines.find((l) => l.code === code);
      return { gtin, display: raw, item: line ? { code: line.code, description: line.description } : null, offline: true };
    }
  }

  // Shared by the camera and "Type code".
  // source: 'camera', 'ring' (Bluetooth scanner) or 'typed'.
  async function handleBarcode(raw, format, source) {
    const fromCamera = source === 'camera';
    const say = (msg, kind) => (fromCamera ? Scanner.setStatus(msg, kind) : toast(msg, kind === 'error' ? 'error' : 'ok'));
    let found;
    try { found = await lookup(raw, format); } catch (err) { say(err.message, 'error'); return; }

    // Typed item codes (e.g. 00439) work too.
    let line = found.item
      ? o.lines.find((l) => l.code === found.item.code)
      : o.lines.find((l) => l.code === String(raw).trim().toUpperCase());

    if (!found.item && !line) {
      feedback('error');
      if (found.offline) { say("No signal, and this barcode isn't known yet. Tap the item in the list instead.", 'error'); return; }
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
      await send('pick', line, { picked: line.picked + n, via: source === 'typed' ? 'typed' : 'scan' }, `+${n} ${line.description}`);
      const fresh = lineById(line.id);
      say(`✓ ${fresh.description}: ${fresh.picked}/${fresh.qty}${queue.length ? ' (saved on phone)' : ''}`, 'ok');
      if (!todoLines().length) {
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
    const line = lineById(key);
    try {
      await api.post('/barcodes', { raw, format, code: line.code });
      codes.set(normalizeBarcode(raw, format), line.code);
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
    if (code) await handleBarcode(code, '', fromCamera ? 'camera' : 'typed');
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
    try { await send('out', line, res, `out ${res.qty} ${line.description}`); toast('Marked out'); } catch (err) { toast(err.message, 'error'); }
  }

  ctx.actions.line = async (lineId) => {
    const line = lineById(lineId);
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
        if (n) await send('pick', line, { picked: line.picked + n, via: 'manual' }, `+${n} ${line.description}`);
      } else if (pick === 'set') {
        const n = await askQty({ title: line.description, subtitle: `Total picked (needed: ${line.qty})`, value: line.picked, min: 0, max: line.qty, okText: 'Save' });
        if (n !== null) await send('pick', line, { picked: n, via: 'manual' }, `${line.description} set to ${n}`);
      } else if (pick === 'out') {
        await markOut(line);
      } else if (pick === 'clear') {
        await send('clear', line, {}, `out cleared on ${line.description}`);
      }
    } catch (err) { toast(err.message, 'error'); }
  };

  ctx.actions.undo = undo;
  ctx.actions.bigOn = () => { big = true; store.set('pick-big-view', true); render(); };
  ctx.actions.bigOff = () => { big = false; store.set('pick-big-view', false); render(); };
  ctx.actions.bigNext = () => { bigIdx += 1; renderLists(); };
  ctx.actions.bigPrev = () => { bigIdx = Math.max(0, bigIdx - 1); renderLists(); };
  ctx.actions.bigAll = async (lineId) => {
    const line = lineById(lineId);
    const n = remainingToPick(line);
    try { await send('pick', line, { picked: line.qty, via: 'manual' }, `+${n} ${line.description}`); feedback('ok'); } catch (err) { toast(err.message, 'error'); }
  };
  ctx.actions.addNote = async () => {
    if (await addNote({ orderId: o.id, truck: o.truck })) ctx.refresh();
  };
  ctx.actions.delNote = async (noteId) => { if (await deleteNote(noteId)) ctx.refresh(); };

  ctx.actions.start = async () => {
    try { update(await api.post(`/orders/${o.id}/start`)); toast('Order is yours. Start scanning.', 'ok'); } catch (err) { toast(err.message, 'error'); }
  };
  ctx.actions.scan = () => Scanner.open((text, format) => handleBarcode(text, format, 'camera'), () => typeCode(true));

  // Ring scanner: a scan anywhere on this screen goes straight to the item.
  let busy = false;
  Wedge.onScan(async (code) => {
    try { localStorage.setItem('wedge-seen', String(Date.now())); } catch { /* ignore */ }
    if (Scanner.isOpen()) return;
    if (modalOpen() || busy) { feedback('error'); toast('Finish the open popup first, then scan again.', 'error'); return; }
    if (!canPick()) {
      feedback('error');
      toast(o.status === 'open' && ctx.can('picker') ? 'Tap "Start picking" first, then scan.' : "You can't pick this order right now.", 'error');
      return;
    }
    busy = true;
    try { await handleBarcode(code, '', 'ring'); } finally { busy = false; renderScannerChip(); }
  });
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
    if (queue.length) { toast('Some changes are still saved on this phone. Finish once you have signal again.', 'error'); return; }
    const outs = o.lines.filter((l) => l.out_qty > 0);
    const ok = outs.length
      ? await confirmBox('Send to supervisor?', `${outs.length} item${outs.length === 1 ? ' is' : 's are'} marked out. A supervisor will be notified to double-check before the order is finished.`, 'Send')
      : await confirmBox('Finish order?', 'Every item is picked.', 'Finish');
    if (!ok) return;
    try {
      update(await api.post(`/orders/${o.id}/submit`));
      store.set(oKey, null);
      toast(o.status === 'done' ? 'Order finished' : 'Sent to supervisor', 'ok');
      await nextOrder(ctx, o.truck);
    } catch (err) { toast(err.message, 'error'); }
  };

  ctx.refresh = async () => {
    if (queue.length) return; // don't overwrite changes waiting to be sent
    update(await api.get(`/orders/${id}`));
  };
  render();
}

// After finishing an order: offer the next unstarted stop on the same truck.
export async function nextOrder(ctx, truck) {
  if (!truck) { location.hash = '#/'; return; }
  const pick = await choose('What next?', [
    { key: 'next', label: `Start the next order on Truck ${truck}`, primary: true },
    { key: 'truck', label: `Back to Truck ${truck}` },
  ]);
  if (pick !== 'next') { location.hash = `#/truck/${truck}`; return; }
  try {
    const next = await api.post(`/trucks/${truck}/next`);
    toast(`Stop ${next.stop}: ${next.store}`, 'ok');
    location.hash = `#/order/${next.id}`;
  } catch (err) {
    toast(err.status === 404 ? `Every order on Truck ${truck} has been started` : err.message, err.status === 404 ? '' : 'error');
    location.hash = `#/truck/${truck}`;
  }
}
