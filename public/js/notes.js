// Notes from drivers, supervisors and management, shown to pickers and loaders.
import { api } from './api.js';
import { esc, toast, ask, confirmBox, fmtTime, ROLE_LABEL } from './ui.js';

const SCOPE_LABEL = {
  order: () => 'This order',
  store: () => 'Every order for this store',
  truck: (n) => (n.day_id ? `Truck ${n.truck} · today's load` : `Truck ${n.truck} · every day`),
};

export const canNote = (ctx) => ctx.user.role === 'driver' || ctx.can('supervisor');

export function notesHtml(notes, ctx, { addArg = '', title = 'Notes' } = {}) {
  if (!notes?.length && !canNote(ctx)) return '';
  return `
    <section class="card notes-card">
      <div class="row"><h2>${esc(title)}${notes?.length ? ` (${notes.length})` : ''}</h2>
        ${canNote(ctx) ? `<button class="btn btn-small btn-ghost" data-act="addNote" data-arg="${esc(addArg)}">+ Add note</button>` : ''}</div>
      ${notes?.length ? `<ul class="notes">${notes.map((n) => `
        <li>
          <span class="note-text">${esc(n.text)}</span>
          <span class="muted small">${SCOPE_LABEL[n.scope](n)} · ${esc(n.user_name || 'Someone')}${n.user_role ? ` (${ROLE_LABEL[n.user_role] || n.user_role})` : ''} · ${fmtTime(n.created_at)}
            ${n.user_id === ctx.user.id || ctx.can('management') ? `<button class="link-btn" data-act="delNote" data-arg="${n.id}">Remove</button>` : ''}</span>
        </li>`).join('')}</ul>` : '<p class="muted small">No notes yet.</p>'}
    </section>`;
}

// options: { orderId } on an order screen, { truck } on a truck screen.
export async function addNote({ orderId, truck }) {
  const scopes = [
    orderId && ['order', 'This order only'],
    orderId && ['store', 'Every order for this store'],
    truck && ['truck', `Truck ${truck} · today's load`],
    truck && ['truckAlways', `Truck ${truck} · every day`],
  ].filter(Boolean);
  const res = await ask({
    title: 'Add a note',
    okText: 'Save note',
    body: `
      <label>Note<textarea name="text" rows="3" maxlength="500" placeholder="${truck ? 'e.g. Load stop 8 last, kegs on the left' : 'e.g. Back door delivery'}"></textarea></label>
      <div class="reason-pick">${scopes.map(([k, label], i) => `<label class="radio"><input type="radio" name="scope" value="${k}" ${i ? '' : 'checked'}> ${esc(label)}</label>`).join('')}</div>`,
    onOk: async (f) => {
      const text = f.elements.text.value.trim();
      if (!text) throw new Error('Type a note');
      const scope = f.elements.scope.value;
      await api.post('/notes', scope.startsWith('truck')
        ? { scope: 'truck', truck, everyDay: scope === 'truckAlways', text }
        : { scope, orderId, text });
      return true;
    },
  });
  if (res) toast('Note saved', 'ok');
  return res;
}

export async function deleteNote(id) {
  if (!await confirmBox('Remove note?', 'It will no longer show to pickers.', 'Remove', true)) return false;
  try { await api.del(`/notes/${id}`); return true; } catch (err) { toast(err.message, 'error'); return false; }
}
