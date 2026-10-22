'use strict';
// Local stand-in for Apps Script, for trying the pages without Google:
//   node test/harness.js   then open http://localhost:3500/?as=teacher
// ?as=teacher or ?as=<student email> picks who you are. google.script.run is
// imitated with fetch, the spreadsheet and Drive are kept in memory.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

Object.assign(globalThis, require('../src/server/Core.js'));
const { createApi, HttpError } = require('../src/server/Api.js');
globalThis.HttpError = HttpError;
const { MemoryStore } = require('./memory-store.js');

const OWNER = 'teacher@school.org';
const db = new MemoryStore();
const drive = new Map();
let settings = {};
const PORT = Number(process.env.PORT) || 3500;
const api = createApi({
  db,
  ownerEmail: OWNER,
  withLock: (fn) => fn(),
  files: { save: (n, m, d) => (drive.set(n, d), n), read: (id) => drive.get(id), remove: (id) => drive.delete(id) },
  exportResults: (title, rows) => `about:blank#${encodeURIComponent(title)}-${rows.length}`,
  settings: {
    get: () => ({ recorderUrl: settings.recorderUrl || `http://localhost:${PORT}/recorder.html`, spreadsheetUrl: 'about:blank', recordingsUrl: 'about:blank' }),
    set: (s) => (settings = s),
  },
});

function userFor(email) {
  email = String(email || '').toLowerCase();
  if (email === 'teacher' || email === OWNER || db.get('teachers', email)) return { id: OWNER, email: OWNER, role: 'teacher', name: 'teacher' };
  const s = db.get('students', email);
  if (!s) return { role: null, email };
  return { id: email, email, role: 'student', name: s.name, className: s.className, readAloud: !!s.readAloud, voiceAnswers: !!s.voiceAnswers, extraTimePct: s.extraTimePct || 0 };
}

const SHIM = `<script>
const AS = new URLSearchParams(location.search).get('as') || '';
window.google = { script: { get run() {
  let ok = () => {}, fail = () => {};
  const runner = new Proxy({}, { get(_, name) {
    if (name === 'withSuccessHandler') return (f) => ((ok = f), runner);
    if (name === 'withFailureHandler') return (f) => ((fail = f), runner);
    return (...args) => fetch('/rpc', { method: 'POST', body: JSON.stringify({ fn: name, args, as: AS }) })
      .then((r) => r.text()).then(ok, fail);
  } });
  return runner;
} } };
</script>`;

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/rpc') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { args, as } = JSON.parse(body);
        const [method, p, b] = args;
        let out;
        try {
          out = { ok: true, data: api.handle(method, p, b, userFor(as)) ?? null };
        } catch (e) {
          const status = e instanceof ValidationError ? 400 : e.status || 500;
          if (status === 500) console.error(e);
          out = { ok: false, status, error: e.message };
        }
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (url.pathname === '/recorder.html') {
      // The real recorder only trusts Google's domains; let it trust us here.
      const page = fs.readFileSync(path.join(__dirname, '..', 'recorder.html'), 'utf8').replace(
        'function trusted(origin) {',
        `function trusted(origin) { if (origin === 'http://localhost:${PORT}') return true;`,
      );
      return res.end(page);
    }
    if (url.pathname === '/') {
      const boot = JSON.stringify({ user: userFor(url.searchParams.get('as')), recorderUrl: api.handle('GET', '/api/settings', null, userFor('teacher')).recorderUrl });
      const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'Index.html'), 'utf8')
        .replace('<?!= boot ?>', boot.replace(/</g, '\\u003c'))
        .replace('<div id="app">', `${SHIM}\n<div id="app">`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(html);
    }
    res.statusCode = 404;
    res.end('Not found');
  })
  .listen(PORT, () => console.log(`Harness on http://localhost:${PORT}/?as=teacher`));
