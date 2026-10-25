// Shared helpers. Loaded first; everything here is global.

const BOOT = JSON.parse(document.getElementById('boot').textContent);
const App = {};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// All server calls go through one Apps Script function, rpc(), with
// REST-style paths so the pages read like ordinary web code.
function api(method, url, body) {
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler((text) => {
        let r;
        try {
          r = JSON.parse(text);
        } catch (e) {
          return reject(new ApiError(500, 'Unexpected reply from the server.'));
        }
        if (r.ok) resolve(r.data);
        else reject(new ApiError(r.status, r.error));
      })
      .withFailureHandler((e) => reject(new ApiError(0, `Connection problem: ${(e && e.message) || e}`)))
      .rpc(method, url, body === undefined ? null : body);
  });
}

// Small DOM builder. Text always goes in as text, never as HTML.
function h(tag, props, ...children) {
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

function clear(el, ...children) {
  el.replaceChildren();
  for (const c of children.flat(Infinity)) if (c) el.append(c);
  return el;
}

function toast(message, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = h('div', { class: `toast toast-${kind}`, text: message });
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { timeStyle: 'medium' }) : '');
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
const isRtl = (lang) => ['he', 'ar'].includes(String(lang || '').slice(0, 2));
const LETTERS = 'ABCDEFGHIJKL';
// Multiple choice may have one correct option (a number) or several (an array).
const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const optionText = (q, list) => asList(list).map((i) => `${LETTERS[i]}. ${q.options[i]}`).join(' · ');

function header(links = []) {
  const user = BOOT.user;
  return h(
    'header',
    { class: 'topbar' },
    h('a', { class: 'brand', href: user.role === 'teacher' ? '#tests' : '#my' }, 'Online Tests'),
    h('nav', {}, links.map(([label, href]) => h('a', { href }, label))),
    h('div', { class: 'who', text: user.role === 'student' ? `${user.name} · ${user.email}` : user.email }),
  );
}

function modal(title, body, actions) {
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

function base64ToBlob(data, mime) {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Recordings live in Drive; load one only when someone presses play.
function recordingPlayer(id, label) {
  const box = h('div', { class: 'record-done' });
  const play = h('button', { class: 'btn', type: 'button' }, `▶ ${label || 'Play voice answer'}`);
  play.addEventListener('click', async () => {
    play.disabled = true;
    play.textContent = 'Loading…';
    try {
      const r = await api('GET', `/api/recordings/${id}`);
      const audio = h('audio', { controls: true, autoplay: true, src: URL.createObjectURL(base64ToBlob(r.data, r.mime)) });
      // Some browsers refuse blob: media inside the Apps Script frame.
      audio.addEventListener('error', () => (audio.src = `data:${r.mime};base64,${r.data}`), { once: true });
      clear(box, audio);
    } catch (e) {
      play.disabled = false;
      play.textContent = `▶ ${label || 'Play voice answer'}`;
      toast(e.message, 'error');
    }
  });
  box.append(play);
  return box;
}
