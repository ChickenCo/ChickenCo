// Admin: employee logins (username + PIN, no email).
import { api } from '../api.js';
import { esc, toast, ask, ROLE_LABEL } from '../ui.js';

const view = document.getElementById('view');

const ROLE_HELP = {
  picker: 'Picks orders and marks items out',
  supervisor: 'Also checks outs, approves orders, assigns orders',
  management: 'Also enters orders, manages items, sees reports',
  admin: 'Everything, including employees and settings',
};

const roleSelect = (value) => `
  <label>Role<select name="role">${Object.keys(ROLE_LABEL).map((r) =>
    `<option value="${r}" ${r === value ? 'selected' : ''}>${ROLE_LABEL[r]} – ${ROLE_HELP[r]}</option>`).join('')}</select></label>`;

const pinInput = (label) => `<label>${label}<input name="pin" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="8" placeholder="4 to 8 digits"></label>`;

const cleanUsername = (s) => s.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);

export async function usersView(ctx) {
  ctx.chrome('Employees', '#/');
  let users = [];
  const render = async () => {
    users = await api.get('/users');
    view.innerHTML = `
      <div class="toolbar"><button class="btn btn-primary" data-act="add">+ Add employee</button></div>
      <ul class="lines">${users.map((u) => `
        <li class="line ${u.active ? '' : 'inactive'}" data-act="edit" data-arg="${u.id}">
          <span class="line-main">
            <span class="line-name">${esc(u.name)}${u.active ? '' : ' <span class="pill">Disabled</span>'}</span>
            <span class="muted small">${esc(u.username)} · ${ROLE_LABEL[u.role]}</span>
          </span>
          <span class="chev">›</span>
        </li>`).join('')}</ul>
      <p class="muted small">Employees sign in with their username and PIN. If someone forgets their PIN, open their account here and set a new one.</p>`;
  };

  ctx.actions.add = async () => {
    const ok = await ask({
      title: 'Add employee',
      okText: 'Create',
      body: `
        <label>Full name<input name="name" autocomplete="off" autocapitalize="words"></label>
        <label>Username<input name="newUsername" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="filled in from the name"></label>
        <p class="muted small">Lowercase letters and numbers only, no spaces. This is what they type to sign in.</p>
        ${roleSelect('picker')}
        ${pinInput('Starting PIN')}
        <p class="muted small">Give the employee their username and PIN. They can change the PIN under My account.</p>`,
      onOpen: (f) => {
        const name = f.elements.name;
        const user = f.elements.newUsername;
        let edited = false;
        // Suggest first initial + last name ("Sam Rivers" -> "srivers") until the admin types their own.
        name.oninput = () => {
          if (edited) return;
          const parts = name.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
          user.value = cleanUsername(parts.length > 1 ? parts[0][0] + parts.at(-1) : parts[0] || '');
        };
        user.oninput = () => { edited = true; user.value = cleanUsername(user.value); };
      },
      onOk: async (f) => {
        const body = { name: f.elements.name.value, username: f.elements.newUsername.value, role: f.elements.role.value, pin: f.elements.pin.value };
        await api.post('/users', body);
        return body;
      },
    });
    if (ok) {
      render();
      await ask({
        title: 'Employee created',
        okText: 'Done',
        cancelText: '',
        body: `<p>Give ${esc(ok.name)} these to sign in:</p>
          <p class="login-slip">Username: <b>${esc(ok.username)}</b><br>PIN: <b>${esc(ok.pin)}</b></p>`,
      });
    }
  };

  ctx.actions.edit = async (id) => {
    const u = users.find((x) => String(x.id) === id);
    const ok = await ask({
      title: u.name,
      okText: 'Save',
      body: `
        <p class="muted">Username: <b>${esc(u.username)}</b></p>
        <label>Full name<input name="name" value="${esc(u.name)}" autocomplete="off"></label>
        ${roleSelect(u.role)}
        ${pinInput('New PIN (leave blank to keep)')}
        <label class="radio"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Account active (untick to block sign-in)</label>`,
      onOk: async (f) => {
        await api.put(`/users/${u.id}`, { name: f.elements.name.value, role: f.elements.role.value, pin: f.elements.pin.value || undefined, active: f.elements.active.checked });
        return true;
      },
    });
    if (ok) { toast('Saved', 'ok'); render(); }
  };

  await render();
}
