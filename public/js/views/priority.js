// Supervisors: the order pack types go in on every pick list (30 packs first, then 18 packs, ...).
import { api } from '../api.js';
import { esc, toast } from '../ui.js';
import { priorityOf } from '../priority.js';

const view = document.getElementById('view');

export async function priorityView(ctx) {
  ctx.chrome('Pick priority', '#/');
  let rules = (ctx.pickPriority || []).map((r) => ({ label: r.label, words: r.match.join(', ') }));
  const items = await api.get('/items').catch(() => []);

  const asRules = () => rules.map((r) => ({ label: r.label.trim(), match: r.words.split(',').map((w) => w.trim()).filter(Boolean) }));

  function preview() {
    const live = asRules();
    const groups = [...live.map((r) => ({ label: r.label || 'Untitled', items: [] })), { label: 'Everything else', items: [] }];
    for (const it of items) groups[priorityOf(it.description, live)].items.push(it);
    const box = document.getElementById('prioPreview');
    if (!box) return;
    box.innerHTML = items.length ? groups.map((g, i) => `
      <li><b>${i < live.length ? `${i + 1}. ` : ''}${esc(g.label)}</b> <span class="muted">· ${g.items.length} item${g.items.length === 1 ? '' : 's'}</span>
        ${g.items.length ? `<span class="muted small prio-eg">${g.items.slice(0, 4).map((x) => esc(x.description)).join(' · ')}${g.items.length > 4 ? ' …' : ''}</span>` : ''}</li>`).join('')
      : '<li class="muted">Import a VIP file to see which items each rule catches.</li>';
  }

  function render() {
    view.innerHTML = `
      <p class="muted small">Pick lists show items in this order, top to bottom. Each rule catches items whose description contains any of its words, e.g. <b>30/12</b> or <b>30 PK</b>. "2/12" won't catch "12/12", so list both if you want both. Anything not caught goes last, in VIP order.</p>
      <div id="prioRules">${rules.map((r, i) => `
        <section class="card prio-rule" data-i="${i}">
          <div class="row"><b class="prio-num">${i + 1}</b>
            <span class="btn-group">
              <button class="btn btn-small btn-ghost" data-act="up" data-arg="${i}" ${i ? '' : 'disabled'} aria-label="Move up">↑</button>
              <button class="btn btn-small btn-ghost" data-act="down" data-arg="${i}" ${i < rules.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button>
              <button class="btn btn-small btn-ghost btn-danger-text" data-act="del" data-arg="${i}" aria-label="Remove rule">✕</button>
            </span></div>
          <label>Name<input name="label" value="${esc(r.label)}" placeholder="e.g. 30 packs" autocomplete="off"></label>
          <label>Words to look for (comma between)<input name="words" value="${esc(r.words)}" placeholder="30/12, 30 PK" autocomplete="off" autocapitalize="characters"></label>
        </section>`).join('') || '<p class="muted">No rules yet: pick lists follow VIP order.</p>'}</div>
      <div class="toolbar">
        <button class="btn btn-ghost" data-act="add">+ Add rule</button>
        <button class="btn btn-primary" data-act="save">Save priority</button>
      </div>
      <section class="card"><h2>Which items go where</h2><ul class="plain prio-preview" id="prioPreview"></ul></section>`;
    view.querySelectorAll('.prio-rule input').forEach((inp) => {
      inp.oninput = () => { rules[Number(inp.closest('.prio-rule').dataset.i)][inp.name] = inp.value; preview(); };
    });
    preview();
  }

  const move = (i, d) => { const j = i + d; [rules[i], rules[j]] = [rules[j], rules[i]]; render(); };
  ctx.actions.up = (i) => move(Number(i), -1);
  ctx.actions.down = (i) => move(Number(i), 1);
  ctx.actions.del = (i) => { rules.splice(Number(i), 1); render(); };
  ctx.actions.add = () => { rules.push({ label: '', words: '' }); render(); view.querySelector('.prio-rule:last-child input[name=label]')?.focus(); };
  ctx.actions.save = async () => {
    try {
      const r = await api.put('/settings/priority', { rules: asRules() });
      ctx.pickPriority = r.pickPriority;
      rules = r.pickPriority.map((x) => ({ label: x.label, words: x.match.join(', ') }));
      render();
      toast('Pick priority saved. Pick lists use it right away.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  };
  render();
}
