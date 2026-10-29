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
const MULTI_ACCOUNT_HELP =
  'If you are signed in to more than one Google account in this browser, Google often fails to answer. ' +
  'Open the app in an Incognito window (Ctrl+Shift+N) or a Chrome profile with only your school account.';

// ----- "something is happening" feedback
// The button or link just pressed shows a spinner until its request answers,
// and a thin bar runs along the top while anything is loading. Background
// calls (autosave, status checks) pass { quiet: true } and show nothing.
const Busy = { n: 0, pressed: null, pressedAt: 0, barTimer: null };
const notePress = (e) => {
  const el = e.target && e.target.closest && e.target.closest('button, a, summary, select, input[type=checkbox]');
  if (el) Object.assign(Busy, { pressed: el, pressedAt: Date.now() });
};
document.addEventListener('pointerdown', notePress, true);
document.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && notePress(e), true);
document.addEventListener('change', notePress, true);

function busyStart() {
  Busy.n++;
  if (Busy.n === 1) {
    clearTimeout(Busy.barTimer);
    // Only show the bar if the wait is noticeable.
    Busy.barTimer = setTimeout(() => document.documentElement.classList.add('is-loading'), 150);
  }
  const el = Date.now() - Busy.pressedAt < 1500 ? Busy.pressed : null;
  Busy.pressed = null;
  if (el && el.isConnected && !el.classList.contains('is-busy')) {
    el.classList.add('is-busy');
    el.setAttribute('aria-busy', 'true');
    return el;
  }
  return null;
}

function busyEnd(el) {
  Busy.n = Math.max(0, Busy.n - 1);
  if (!Busy.n) {
    clearTimeout(Busy.barTimer);
    document.documentElement.classList.remove('is-loading');
  }
  if (el) {
    el.classList.remove('is-busy');
    el.removeAttribute('aria-busy');
  }
}

function api(method, url, body, { quiet = false } = {}) {
  // Data the server sent along with the page, for the first screen.
  const key = `${method} ${url}`;
  // Only right after the page opens; later it could be out of date.
  if (BOOT.prefetch && performance.now() > 20000) BOOT.prefetch = null;
  if (BOOT.prefetch && key in BOOT.prefetch) {
    const data = BOOT.prefetch[key];
    delete BOOT.prefetch[key];
    return Promise.resolve(data);
  }
  const el = quiet ? null : busyStart();
  return new Promise((resolve, reject) => {
    // Google sometimes never answers at all (most often with several
    // accounts signed in), so don't wait forever.
    const timer = setTimeout(() => reject(new ApiError(0, `No answer from Google after 45 seconds. ${MULTI_ACCOUNT_HELP}`)), 45000);
    const done = (fn) => (x) => {
      clearTimeout(timer);
      fn(x);
    };
    google.script.run
      .withSuccessHandler(done((text) => {
        let r;
        try {
          r = JSON.parse(text);
        } catch (e) {
          return reject(new ApiError(500, 'Unexpected reply from the server.'));
        }
        if (r.ok) resolve(r.data);
        else reject(new ApiError(r.status, r.error));
      }))
      .withFailureHandler(done((e) => reject(new ApiError(0, `Problem reaching Google: ${(e && e.message) || e}. ${MULTI_ACCOUNT_HELP}`))))
      .rpc(method, url, body === undefined ? null : body);
  }).finally(() => quiet || busyEnd(el));
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
