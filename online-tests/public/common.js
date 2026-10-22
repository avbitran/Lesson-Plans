// Shared helpers for every page.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, url, body, { raw = false, contentType } = {}) {
  const headers = { 'X-Requested-With': 'fetch' };
  let payload;
  if (body instanceof Blob) {
    payload = body;
    headers['Content-Type'] = contentType || body.type;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/setup')) {
    location.href = '/';
    throw new ApiError(401, 'Please log in.');
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

// Small DOM builder. Text always goes in as text, never as HTML.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el, ...children) {
  el.replaceChildren();
  for (const c of children.flat(Infinity)) if (c) el.append(c);
  return el;
}

export function toast(message, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = h('div', { class: `toast toast-${kind}`, text: message });
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

export const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';

export const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { timeStyle: 'medium' }) : '');

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const RTL_LANGS = ['he', 'ar'];
export const isRtl = (lang) => RTL_LANGS.includes(String(lang || '').slice(0, 2));

export const LETTERS = 'ABCDEFGHIJKL';

export async function logout() {
  await api('POST', '/api/logout').catch(() => {});
  location.href = '/';
}

export async function requireUser(role) {
  const { user } = await api('GET', '/api/me');
  if (!user) {
    location.href = '/';
    throw new Error('not logged in');
  }
  if (role && user.role !== role) {
    location.href = user.role === 'teacher' ? '/teacher' : '/student';
    throw new Error('wrong role');
  }
  return user;
}

export function header(user, links = []) {
  return h(
    'header',
    { class: 'topbar' },
    h('a', { class: 'brand', href: user.role === 'teacher' ? '/teacher' : '/student' }, 'Online Tests'),
    h('nav', {}, links.map(([label, href]) => h('a', { href }, label))),
    h(
      'div',
      { class: 'who' },
      h('span', { text: user.name }),
      h('button', { class: 'btn btn-ghost', onclick: () => changePassword() }, 'Password'),
      h('button', { class: 'btn btn-ghost', onclick: logout }, 'Log out'),
    ),
  );
}

export function modal(title, body, actions) {
  const dlg = h('dialog', { class: 'modal' });
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  dlg.append(
    h('h2', { text: title }),
    body,
    h(
      'div',
      { class: 'modal-actions' },
      (actions || [['Close', null]]).map(([label, fn, cls]) =>
        h('button', { class: `btn ${cls || ''}`, onclick: async () => ((await fn?.()) === false ? null : close()) }, label),
      ),
    ),
  );
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close };
}

function changePassword() {
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  modal(
    'Change password',
    h('div', { class: 'form' }, h('label', {}, 'Current password', current), h('label', {}, 'New password (8+ characters)', next)),
    [
      ['Cancel', null],
      [
        'Save',
        async () => {
          try {
            await api('PUT', '/api/me/password', { current: current.value, next: next.value });
            toast('Password changed.', 'ok');
          } catch (e) {
            toast(e.message, 'error');
            return false;
          }
        },
        'btn-primary',
      ],
    ],
  );
}
