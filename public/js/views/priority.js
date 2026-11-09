// Supervisors: the pick priority list. Search for items and put them in the order they should be picked,
// with optional headings ("30 packs", "Back wall"...). Items not on the list go last, in VIP order.
import { api } from '../api.js';
import { esc, toast, ask, confirmBox } from '../ui.js';
import { priorityOf } from '../priority.js';

const view = document.getElementById('view');
const MAX_RESULTS = 40;

export async function priorityView(ctx) {
  ctx.chrome('Pick priority', '#/');
  const items = await api.get('/items').catch(() => []);
  const byCode = new Map(items.map((i) => [i.code, i]));
  let list = (ctx.pickPriorityList || []).map((e) => ({ ...e }));
  let dirty = false;
  let q = '';
  let target = ''; // add new items at the end of this heading's section ('' = end of the list)

  const onList = () => new Set(list.filter((e) => e.type === 'item').map((e) => e.code));
  const nameOf = (e) => byCode.get(e.code)?.description || e.description || '(item not in the item list)';
  const headings = () => list.map((e, i) => ({ e, i })).filter((x) => x.e.type === 'heading');
  // Sections: a heading plus the items under it (and any items above the first heading).
  const blocks = () => {
    const out = [];
    list.forEach((e, i) => { if (!i || e.type === 'heading') out.push({ start: i, end: i }); else out.at(-1).end = i; });
    out.forEach((b) => { b.end = Math.max(b.end, b.start); });
    return out;
  };

  function render() {
    const rules = ctx.pickPriority || [];
    view.innerHTML = `
      <p class="muted small">Pick lists show items in this order, top to bottom. Search for an item and tap <b>Add</b>. Headings (like <b>30 packs</b> or <b>Back wall</b>) show on the pick list above the items under them. Items not on this list go last, in VIP order.</p>
      ${!ctx.pickPriorityList ? `<div class="banner">No list saved yet, so pick lists use the older word rules${rules.length ? ` (${esc(rules.map((r) => r.label).join(', '))})` : ''}.
        ${rules.length && items.length ? '<button class="link-btn" data-act="fromRules">Start this list from those rules</button>' : ''}</div>` : ''}
      <section class="card prio-search">
        <input type="search" id="prioQ" placeholder="Search items: name or item #" value="${esc(q)}" autocomplete="off" autocapitalize="characters">
        ${headings().length ? `<label class="small">Add to
          <select id="prioTarget"><option value="">End of the list</option>${headings().map((h) => `<option value="${h.i}" ${String(h.i) === target ? 'selected' : ''}>Under "${esc(h.e.label)}"</option>`).join('')}</select></label>` : ''}
        <ul class="lines prio-results" id="prioResults"></ul>
      </section>
      <div class="row"><h2 class="section-title">Priority list (${list.filter((e) => e.type === 'item').length} items)</h2>
        <button class="btn btn-small btn-ghost" data-act="addHeading">+ Heading</button></div>
      <ol class="prio-list" id="prioList"></ol>
      <div class="bottom-bar">
        ${list.length ? '<button class="btn btn-ghost btn-danger-text" data-act="clear">Clear</button>' : ''}
        <button class="btn btn-primary btn-scan" data-act="save" id="prioSave">${dirty ? 'Save changes' : 'Saved'}</button>
      </div>`;
    const input = document.getElementById('prioQ');
    input.oninput = () => { q = input.value.trim(); renderResults(); };
    const sel = document.getElementById('prioTarget');
    if (sel) sel.onchange = () => { target = sel.value; };
    renderResults();
    renderList();
  }

  function renderResults() {
    const box = document.getElementById('prioResults');
    if (!box) return;
    if (!q) { box.innerHTML = items.length ? '' : '<li class="muted">No items yet. Import a VIP file first.</li>'; return; }
    const words = q.toUpperCase().split(/\s+/).filter(Boolean);
    const hits = items.filter((i) => words.every((w) => i.description.toUpperCase().includes(w) || i.code.toUpperCase().includes(w)));
    const have = onList();
    box.innerHTML = hits.slice(0, MAX_RESULTS).map((i) => `
      <li class="line">
        <span class="line-main"><span class="line-name">${esc(i.description)}</span><span class="muted small">#${esc(i.code)}</span></span>
        ${have.has(i.code) ? '<span class="muted small">On list ✓</span>' : `<button class="btn btn-small btn-primary" data-act="addItem" data-arg="${esc(i.code)}">Add</button>`}
      </li>`).join('')
      + (hits.length > MAX_RESULTS ? `<li class="muted small">${hits.length - MAX_RESULTS} more. Type more of the name to narrow it down.</li>` : '')
      + (hits.length > 1 && hits.some((i) => !have.has(i.code)) ? `<li><button class="btn btn-small btn-ghost" data-act="addAll">Add all ${hits.filter((i) => !have.has(i.code)).length} shown</button></li>` : '')
      || '<li class="muted">No items match.</li>';
  }

  function renderList() {
    const box = document.getElementById('prioList');
    if (!box) return;
    let n = 0;
    const bl = blocks();
    const blockAt = (i) => bl.findIndex((b) => b.start === i);
    const canUp = (e, i) => (e.type === 'heading' ? blockAt(i) > 0 : i > 0);
    const canDown = (e, i) => (e.type === 'heading' ? blockAt(i) < bl.length - 1 : i < list.length - 1);
    box.innerHTML = list.map((e, i) => `
      <li class="prio-entry ${e.type}">
        ${e.type === 'heading'
    ? `<b class="prio-heading">${esc(e.label)}</b>`
    : `<span class="prio-num">${++n}</span><span class="line-main"><span class="line-name">${esc(nameOf(e))}</span><span class="muted small">#${esc(e.code)}</span></span>`}
        <span class="btn-group">
          ${e.type === 'heading' ? `<button class="btn btn-small btn-ghost" data-act="rename" data-arg="${i}" aria-label="Rename heading">✎</button>` : ''}
          <button class="btn btn-small btn-ghost" data-act="up" data-arg="${i}" ${canUp(e, i) ? '' : 'disabled'} aria-label="${e.type === 'heading' ? 'Move section up' : 'Move up'}">↑</button>
          <button class="btn btn-small btn-ghost" data-act="down" data-arg="${i}" ${canDown(e, i) ? '' : 'disabled'} aria-label="${e.type === 'heading' ? 'Move section down' : 'Move down'}">↓</button>
          <button class="btn btn-small btn-ghost btn-danger-text" data-act="del" data-arg="${i}" aria-label="Remove">✕</button>
        </span>
      </li>`).join('') || '<li class="muted">Nothing on the list yet. Search above to add items.</li>';
  }

  const changed = (full = false) => {
    dirty = true;
    if (full) { render(); return; }
    renderList();
    renderResults();
    const btn = document.getElementById('prioSave');
    if (btn) btn.textContent = 'Save changes';
  };

  // Insert after the last entry of the chosen heading's section, or at the end.
  function insert(entries) {
    let at = list.length;
    if (target !== '' && list[Number(target)]?.type === 'heading') {
      at = Number(target) + 1;
      while (at < list.length && list[at].type !== 'heading') at += 1;
    }
    list.splice(at, 0, ...entries);
    // Keep the target pointing at the same heading.
    if (target !== '' && at <= Number(target)) target = String(Number(target) + entries.length);
  }

  ctx.actions.addItem = (code) => {
    if (onList().has(code)) return;
    insert([{ type: 'item', code }]);
    changed();
    toast(`Added ${byCode.get(code)?.description || code}`, 'ok');
  };
  ctx.actions.addAll = () => {
    const words = q.toUpperCase().split(/\s+/).filter(Boolean);
    const have = onList();
    const add = items.filter((i) => !have.has(i.code) && words.every((w) => i.description.toUpperCase().includes(w) || i.code.toUpperCase().includes(w)))
      .slice(0, MAX_RESULTS).map((i) => ({ type: 'item', code: i.code }));
    insert(add);
    changed();
    toast(`Added ${add.length} items`, 'ok');
  };
  const headingName = (title, value = '') => ask({
    title,
    okText: 'Save',
    body: `<label>Heading<input name="label" maxlength="60" value="${esc(value)}" placeholder="e.g. 30 packs" autocomplete="off"></label>`,
    onOk: (f) => { const v = f.elements.label.value.trim(); if (!v) throw new Error('Type a heading'); return v; },
  });
  ctx.actions.addHeading = async () => {
    const label = await headingName('New heading');
    if (!label) return;
    list.push({ type: 'heading', label });
    target = String(list.length - 1);
    changed(true);
  };
  ctx.actions.rename = async (i) => {
    const e = list[Number(i)];
    const label = await headingName('Rename heading', e.label);
    if (label) { e.label = label; changed(true); }
  };
  const move = (i, d) => {
    const keep = target === '' ? null : list[Number(target)];
    if (list[i].type === 'heading') {
      // A heading takes its whole section with it, past the neighbouring section.
      const bl = blocks();
      const b = bl.findIndex((x) => x.start === i);
      const other = bl[b + d];
      if (!other) return;
      const [first, second] = d < 0 ? [other, bl[b]] : [bl[b], other];
      const a = list.slice(first.start, first.end + 1);
      const c = list.slice(second.start, second.end + 1);
      list.splice(first.start, a.length + c.length, ...c, ...a);
    } else {
      const j = i + d;
      [list[i], list[j]] = [list[j], list[i]];
    }
    if (keep) target = String(list.indexOf(keep));
    changed(true);
  };
  ctx.actions.up = (i) => move(Number(i), -1);
  ctx.actions.down = (i) => move(Number(i), 1);
  ctx.actions.del = (i) => {
    const k = Number(i);
    const wasHeading = list[k].type === 'heading';
    list.splice(k, 1);
    if (target === String(k)) target = '';
    else if (target !== '' && Number(target) > k) target = String(Number(target) - 1);
    changed(wasHeading);
  };
  ctx.actions.clear = async () => {
    if (!await confirmBox('Clear the priority list?', 'Every item and heading comes off the list. Nothing changes on pick lists until you tap Save.', 'Clear', true)) return;
    list = [];
    target = '';
    changed(true);
  };
  ctx.actions.fromRules = () => {
    const rules = ctx.pickPriority || [];
    const groups = rules.map((r) => ({ label: r.label, codes: [] }));
    for (const it of items) {
      const p = priorityOf(it.description, rules);
      if (p < rules.length) groups[p].codes.push(it.code);
    }
    list = groups.filter((g) => g.codes.length).flatMap((g) => [{ type: 'heading', label: g.label }, ...g.codes.map((code) => ({ type: 'item', code }))]);
    target = '';
    changed(true);
    toast('List started from the word rules. Check it, then Save.', 'ok');
  };
  ctx.actions.save = async () => {
    try {
      const r = await api.put('/settings/priority-list', { list });
      ctx.pickPriorityList = r.pickPriorityList;
      list = (r.pickPriorityList || []).map((e) => ({ ...e }));
      dirty = false;
      target = '';
      render();
      toast(r.pickPriorityList ? 'Priority list saved. Pick lists use it right away.' : 'List cleared. Pick lists use the word rules again.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  };
  render();
}
