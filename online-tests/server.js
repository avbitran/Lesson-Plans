'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { open } = require('./lib/db');
const auth = require('./lib/auth');
const T = require('./lib/tests');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const REC_DIR = path.join(DATA_DIR, 'recordings');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

const SESSION_MS = { teacher: 7 * 24 * 3600e3, student: 12 * 3600e3 };
const DEADLINE_GRACE_MS = 30e3; // network slack for the last autosave
const MAX_JSON = 2 * 1024 * 1024;
const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_EVENTS_PER_ATTEMPT = 1000;

const db = open(DATA_DIR);

// ---------------------------------------------------------------- first run

let setupCode = null;
function refreshSetupCode() {
  const hasTeacher = db.prepare("SELECT 1 FROM users WHERE role = 'teacher' LIMIT 1").get();
  if (hasTeacher) {
    setupCode = null;
  } else if (!setupCode) {
    setupCode = process.env.SETUP_CODE || crypto.randomInt(100000, 1000000).toString();
    console.log(`\n  No teacher account yet. Open the site and use setup code: ${setupCode}\n`);
  }
}

// ------------------------------------------------------------------ helpers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'microphone=(self), fullscreen=(self), camera=()',
  'Content-Security-Policy':
    "default-src 'self'; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'That upload is too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Malformed request.');
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(req, token, maxAgeMs) {
  const secure = COOKIE_SECURE || req.headers['x-forwarded-proto'] === 'https';
  return [
    `sid=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

const now = () => Date.now();
const parse = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

function publicUser(u) {
  return {
    id: u.id,
    role: u.role,
    username: u.username,
    name: u.name,
    className: u.class_name,
    readAloud: !!u.read_aloud,
    voiceAnswers: !!u.voice_answers,
    extraTimePct: u.extra_time_pct,
  };
}

// ---------------------------------------------------------------- routing

const routes = [];
function route(method, pattern, role, handler) {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$',
  );
  routes.push({ method, re, keys, role, handler });
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const row = db
    .prepare(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?',
    )
    .get(token, now());
  return row || null;
}

// ----------------------------------------------------------- domain helpers

function getTest(id) {
  const row = db.prepare('SELECT * FROM tests WHERE id = ?').get(Number(id));
  if (!row) throw new HttpError(404, 'Test not found.');
  return { ...row, data: parse(row.data, null) };
}

function getAttempt(id) {
  const row = db.prepare('SELECT * FROM attempts WHERE id = ?').get(Number(id));
  if (!row) throw new HttpError(404, 'Attempt not found.');
  return {
    ...row,
    test: parse(row.test_snapshot, null),
    answers: parse(row.answers, {}),
    grading: parse(row.grading, {}),
  };
}

function ownAttempt(id, user) {
  const a = getAttempt(id);
  if (a.student_id !== user.id) throw new HttpError(404, 'Attempt not found.');
  return a;
}

function recordedIds(attemptId) {
  return new Set(
    db.prepare('SELECT question_id FROM recordings WHERE attempt_id = ?').all(attemptId).map((r) => r.question_id),
  );
}

function violationCount(attemptId) {
  return db.prepare('SELECT COUNT(*) AS n FROM events WHERE attempt_id = ? AND counted = 1').get(attemptId).n;
}

function logEvent(attemptId, type, detail = '', counted = false) {
  db.prepare('INSERT INTO events (attempt_id, at, type, detail, counted) VALUES (?, ?, ?, ?, ?)').run(
    attemptId,
    now(),
    type,
    String(detail).slice(0, 300),
    counted ? 1 : 0,
  );
}

function submitAttempt(attempt, reason) {
  const auto = T.autoGrade(attempt.test, attempt.answers, recordedIds(attempt.id));
  const score = T.totalScore(attempt.test, auto, attempt.grading);
  db.prepare(
    "UPDATE attempts SET status = 'submitted', submitted_at = ?, submit_reason = ?, score = ?, max_score = ? WHERE id = ? AND status IN ('in_progress', 'locked')",
  ).run(now(), reason, score, T.maxScore(attempt.test), attempt.id);
  logEvent(attempt.id, 'submitted', reason);
}

// Attempts whose time ran out while the student was away get submitted with
// whatever was autosaved.
function sweepExpired() {
  const rows = db
    .prepare("SELECT id FROM attempts WHERE status IN ('in_progress', 'locked') AND deadline_at IS NOT NULL AND deadline_at + ? < ?")
    .all(DEADLINE_GRACE_MS, now());
  for (const r of rows) submitAttempt(getAttempt(r.id), 'time');
}

function deleteRecordingFiles(rows) {
  for (const r of rows) fs.rm(path.join(REC_DIR, r.file), { force: true }, () => {});
}

function canRecord(user, test) {
  return !!user.voice_answers || test.settings.recordingForAll;
}

function testVisibleTo(row, user) {
  if (row.status !== 'open') return false;
  const classes = row.data.classes.map((c) => c.toLowerCase());
  return classes.length === 0 || classes.includes(user.class_name.toLowerCase());
}

function sanitizeAnswers(test, input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const q of test.questions) {
    if (q.type === 'section' || !(q.id in input)) continue;
    const v = input[q.id];
    if (q.type === 'mc') {
      if (Number.isInteger(v) && v >= 0 && v < q.options.length) out[q.id] = v;
    } else if (typeof v === 'string') {
      out[q.id] = v.slice(0, 20000);
    }
  }
  return out;
}

function studentAttemptPayload(attempt, user) {
  const test = attempt.test;
  return {
    attempt: {
      id: attempt.id,
      status: attempt.status,
      startedAt: attempt.started_at,
      deadlineAt: attempt.deadline_at,
      serverNow: now(),
      answers: attempt.answers,
      violations: violationCount(attempt.id),
    },
    test: T.studentView(test),
    recordings: db
      .prepare('SELECT id, question_id AS questionId, duration FROM recordings WHERE attempt_id = ?')
      .all(attempt.id),
    accommodations: {
      readAloud: !!user.read_aloud || test.settings.readAloudForAll,
      voiceAnswers: canRecord(user, test),
    },
  };
}

// Guards every write a student makes during a test.
function assertWritable(attempt, clientId) {
  if (attempt.status === 'locked') throw new HttpError(423, 'Your test is paused. Ask your teacher to unlock it.');
  if (attempt.status !== 'in_progress') throw new HttpError(409, 'This test has already been submitted.');
  if (attempt.client_id && clientId !== attempt.client_id)
    throw new HttpError(409, 'This test was opened in another window or device. Only the newest one can continue.');
  if (attempt.deadline_at && now() > attempt.deadline_at + DEADLINE_GRACE_MS) {
    submitAttempt(attempt, 'time');
    throw new HttpError(409, 'Time is up. Your test was submitted with your saved answers.');
  }
}

// ------------------------------------------------------------- auth routes

const loginFailures = new Map(); // ip -> { count, first }
function checkLoginRate(ip) {
  const f = loginFailures.get(ip);
  if (f && now() - f.first < 15 * 60e3 && f.count >= 20)
    throw new HttpError(429, 'Too many failed logins. Wait 15 minutes and try again.');
}
function noteLoginFailure(ip) {
  const f = loginFailures.get(ip);
  if (!f || now() - f.first > 15 * 60e3) loginFailures.set(ip, { count: 1, first: now() });
  else f.count++;
}

function startSession(req, res, user) {
  const token = auth.newToken();
  const ttl = SESSION_MS[user.role];
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, now() + ttl);
  res.setHeader('Set-Cookie', sessionCookie(req, token, ttl));
}

route('GET', '/api/setup', null, () => ({ needed: !!setupCode }));

route('POST', '/api/setup', null, async ({ req, res }) => {
  if (!setupCode) throw new HttpError(409, 'Setup is already done. Log in instead.');
  const b = await readJson(req);
  if (String(b.code || '').trim() !== setupCode) throw new HttpError(403, 'Wrong setup code. It is printed in the server log.');
  const name = String(b.name || '').trim().slice(0, 100);
  const username = String(b.username || '').trim().toLowerCase().slice(0, 40);
  const password = String(b.password || '');
  if (!name || !/^[a-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'Pick a name and a username (letters, digits, . _ -).');
  if (password.length < 8) throw new HttpError(400, 'Use a password of at least 8 characters.');
  const r = db
    .prepare("INSERT INTO users (role, username, name, pass_hash, created_at) VALUES ('teacher', ?, ?, ?, ?)")
    .run(username, name, auth.hashPassword(password), now());
  refreshSetupCode();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  startSession(req, res, user);
  return { user: publicUser(user) };
});

route('POST', '/api/login', null, async ({ req, res }) => {
  const ip = req.socket.remoteAddress;
  checkLoginRate(ip);
  const b = await readJson(req);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(b.username || '').trim());
  if (!user || !auth.verifyPassword(String(b.password || ''), user.pass_hash)) {
    noteLoginFailure(ip);
    throw new HttpError(401, 'Wrong username or password.');
  }
  startSession(req, res, user);
  return { user: publicUser(user) };
});

route('POST', '/api/logout', null, ({ req, res }) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  return { ok: true };
});

route('GET', '/api/me', null, ({ req }) => {
  const user = currentUser(req);
  return { user: user ? publicUser(user) : null };
});

route('PUT', '/api/me/password', 'any', async ({ req, user }) => {
  const b = await readJson(req);
  if (!auth.verifyPassword(String(b.current || ''), user.pass_hash)) throw new HttpError(403, 'Your current password is wrong.');
  if (String(b.next || '').length < 8) throw new HttpError(400, 'Use a password of at least 8 characters.');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(String(b.next)), user.id);
  return { ok: true };
});

// ---------------------------------------------------------- teacher: users

route('GET', '/api/users', 'teacher', () => ({
  users: db.prepare('SELECT * FROM users ORDER BY role DESC, class_name, name').all().map(publicUser),
}));

route('POST', '/api/users/bulk', 'teacher', async ({ req }) => {
  const b = await readJson(req);
  const role = b.role === 'teacher' ? 'teacher' : 'student';
  const people = Array.isArray(b.people) ? b.people.slice(0, 500) : [];
  const insert = db.prepare(
    'INSERT INTO users (role, username, name, class_name, pass_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const taken = db.prepare('SELECT 1 FROM users WHERE username = ?');
  const created = [];
  db.exec('BEGIN');
  try {
    for (const p of people) {
      const name = String(p.name || '').trim().slice(0, 100);
      if (!name) continue;
      const className = String(p.className || '').trim().slice(0, 60);
      const base = auth.usernameBase(p.username || name);
      let username = base;
      for (let n = 2; taken.get(username); n++) username = `${base}${n}`;
      const password = auth.generatePassword();
      const r = insert.run(role, username, name, className, auth.hashPassword(password), now());
      created.push({ id: Number(r.lastInsertRowid), name, className, username, password });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { created };
});

route('PUT', '/api/users/:id', 'teacher', async ({ req, params }) => {
  const b = await readJson(req);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
  if (!u) throw new HttpError(404, 'User not found.');
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 100) || u.name : u.name;
  const className = b.className !== undefined ? String(b.className).trim().slice(0, 60) : u.class_name;
  const readAloud = b.readAloud !== undefined ? (b.readAloud ? 1 : 0) : u.read_aloud;
  const voice = b.voiceAnswers !== undefined ? (b.voiceAnswers ? 1 : 0) : u.voice_answers;
  const extra = b.extraTimePct !== undefined ? Math.min(200, Math.max(0, Number.parseInt(b.extraTimePct, 10) || 0)) : u.extra_time_pct;
  db.prepare(
    'UPDATE users SET name = ?, class_name = ?, read_aloud = ?, voice_answers = ?, extra_time_pct = ? WHERE id = ?',
  ).run(name, className, readAloud, voice, extra, u.id);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) };
});

route('POST', '/api/users/:id/reset-password', 'teacher', ({ params }) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
  if (!u) throw new HttpError(404, 'User not found.');
  const password = auth.generatePassword();
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(password), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  return { username: u.username, password };
});

route('DELETE', '/api/users/:id', 'teacher', ({ params, user }) => {
  const id = Number(params.id);
  if (id === user.id) throw new HttpError(400, "You can't delete your own account.");
  if (db.prepare('SELECT 1 FROM tests WHERE owner_id = ?').get(id))
    throw new HttpError(409, 'This teacher owns tests. Delete or keep their tests first.');
  deleteRecordingFiles(
    db.prepare('SELECT r.file FROM recordings r JOIN attempts a ON a.id = r.attempt_id WHERE a.student_id = ?').all(id),
  );
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { ok: true };
});

// ---------------------------------------------------------- teacher: tests

route('GET', '/api/tests', 'teacher', () => {
  sweepExpired();
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.status, t.updated_at, t.data,
        SUM(a.status IN ('in_progress', 'locked')) AS active,
        SUM(a.status = 'submitted') AS to_grade,
        SUM(a.status = 'returned') AS returned
       FROM tests t LEFT JOIN attempts a ON a.test_id = t.id
       GROUP BY t.id ORDER BY t.updated_at DESC`,
    )
    .all();
  return {
    tests: rows.map((r) => {
      const d = parse(r.data, {});
      return {
        id: r.id,
        title: r.title,
        status: r.status,
        updatedAt: r.updated_at,
        classes: d.classes || [],
        questionCount: (d.questions || []).filter((q) => q.type !== 'section').length,
        active: r.active || 0,
        toGrade: r.to_grade || 0,
        returned: r.returned || 0,
      };
    }),
  };
});

route('POST', '/api/tests', 'teacher', async ({ req, user }) => {
  const b = await readJson(req);
  const data = T.normalizeTest(b.data);
  const r = db
    .prepare('INSERT INTO tests (owner_id, title, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, data.title, 'draft', JSON.stringify(data), now(), now());
  return { id: Number(r.lastInsertRowid) };
});

route('GET', '/api/tests/:id', 'teacher', ({ params }) => {
  const t = getTest(params.id);
  return { id: t.id, status: t.status, data: t.data };
});

route('PUT', '/api/tests/:id', 'teacher', async ({ req, params }) => {
  const t = getTest(params.id);
  const b = await readJson(req);
  const data = b.data !== undefined ? T.normalizeTest(b.data) : t.data;
  const status = ['draft', 'open', 'closed'].includes(b.status) ? b.status : t.status;
  db.prepare('UPDATE tests SET title = ?, status = ?, data = ?, updated_at = ? WHERE id = ?').run(
    data.title,
    status,
    JSON.stringify(data),
    now(),
    t.id,
  );
  return { id: t.id, status, data };
});

route('POST', '/api/tests/:id/duplicate', 'teacher', ({ params, user }) => {
  const t = getTest(params.id);
  const data = { ...t.data, title: `${t.data.title} (copy)`.slice(0, 200) };
  const r = db
    .prepare('INSERT INTO tests (owner_id, title, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, data.title, 'draft', JSON.stringify(data), now(), now());
  return { id: Number(r.lastInsertRowid) };
});

route('DELETE', '/api/tests/:id', 'teacher', ({ params }) => {
  const t = getTest(params.id);
  deleteRecordingFiles(
    db.prepare('SELECT r.file FROM recordings r JOIN attempts a ON a.id = r.attempt_id WHERE a.test_id = ?').all(t.id),
  );
  db.prepare('DELETE FROM tests WHERE id = ?').run(t.id);
  return { ok: true };
});

route('GET', '/api/tests/:id/preview', 'teacher', ({ params }) => ({ test: T.studentView(getTest(params.id).data) }));

function attemptRows(testId) {
  sweepExpired();
  return db
    .prepare(
      `SELECT a.*, u.name, u.username, u.class_name,
        (SELECT COUNT(*) FROM events e WHERE e.attempt_id = a.id AND e.counted = 1) AS violations
       FROM attempts a JOIN users u ON u.id = a.student_id
       WHERE a.test_id = ? ORDER BY u.class_name, u.name`,
    )
    .all(testId)
    .map((a) => {
      const test = parse(a.test_snapshot, null);
      const auto = T.autoGrade(test, parse(a.answers, {}), recordedIds(a.id));
      const grading = parse(a.grading, {});
      const toReview = Object.entries(auto).filter(([qid, v]) => v.review && !Number.isFinite(grading[qid]?.points)).length;
      return {
        id: a.id,
        studentId: a.student_id,
        name: a.name,
        username: a.username,
        className: a.class_name,
        status: a.status,
        startedAt: a.started_at,
        deadlineAt: a.deadline_at,
        submittedAt: a.submitted_at,
        submitReason: a.submit_reason,
        score: a.score,
        maxScore: a.max_score ?? T.maxScore(test),
        violations: a.violations,
        toReview,
        answered: Object.keys(parse(a.answers, {})).length,
        questionCount: test.questions.filter((q) => q.type !== 'section').length,
      };
    });
}

route('GET', '/api/tests/:id/attempts', 'teacher', ({ params }) => {
  const t = getTest(params.id);
  const attempts = attemptRows(t.id);
  const started = new Set(attempts.map((a) => a.studentId));
  const classes = t.data.classes.map((c) => c.toLowerCase());
  const notStarted = db
    .prepare("SELECT * FROM users WHERE role = 'student' ORDER BY class_name, name")
    .all()
    .filter((u) => !started.has(u.id) && (classes.length === 0 || classes.includes(u.class_name.toLowerCase())))
    .map((u) => ({ id: u.id, name: u.name, className: u.class_name }));
  return { test: { id: t.id, title: t.title, status: t.status, data: t.data }, attempts, notStarted };
});

route('GET', '/api/tests/:id/export.csv', 'teacher', ({ params, res }) => {
  const t = getTest(params.id);
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
  const lines = [['Name', 'Username', 'Class', 'Status', 'Score', 'Max', 'Started', 'Submitted', 'Times left the test'].join(',')];
  for (const a of attemptRows(t.id))
    lines.push(
      [a.name, a.username, a.className, a.status, a.score, a.maxScore, iso(a.startedAt), iso(a.submittedAt), a.violations]
        .map(cell)
        .join(','),
    );
  const filename = `${t.title.replace(/[^\w\- ]+/g, '').trim() || 'results'}.csv`;
  send(res, 200, '﻿' + lines.join('\r\n'), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  return undefined;
});

// ------------------------------------------------------- teacher: attempts

route('GET', '/api/attempts/:id', 'teacher', ({ params }) => {
  const a = getAttempt(params.id);
  const student = db.prepare('SELECT * FROM users WHERE id = ?').get(a.student_id);
  return {
    attempt: {
      id: a.id,
      testId: a.test_id,
      status: a.status,
      startedAt: a.started_at,
      deadlineAt: a.deadline_at,
      submittedAt: a.submitted_at,
      submitReason: a.submit_reason,
      returnedAt: a.returned_at,
      answers: a.answers,
      grading: a.grading,
      feedback: a.feedback,
      score: a.score,
      maxScore: T.maxScore(a.test),
    },
    test: a.test,
    auto: T.autoGrade(a.test, a.answers, recordedIds(a.id)),
    student: publicUser(student),
    events: db.prepare('SELECT at, type, detail, counted FROM events WHERE attempt_id = ? ORDER BY at').all(a.id),
    recordings: db
      .prepare('SELECT id, question_id AS questionId, duration, created_at AS createdAt FROM recordings WHERE attempt_id = ?')
      .all(a.id),
  };
});

route('PUT', '/api/attempts/:id/grade', 'teacher', async ({ req, params }) => {
  const a = getAttempt(params.id);
  if (!['submitted', 'returned'].includes(a.status)) throw new HttpError(409, 'The student has not submitted yet.');
  const b = await readJson(req);
  const grading = {};
  for (const q of a.test.questions) {
    if (q.type === 'section') continue;
    const g = b.grading?.[q.id];
    if (!g) continue;
    const pts = g.points === null || g.points === '' || g.points === undefined ? null : Number(g.points);
    grading[q.id] = {
      points: Number.isFinite(pts) ? Math.min(q.points, Math.max(0, pts)) : null,
      comment: String(g.comment || '').slice(0, 2000),
    };
  }
  const auto = T.autoGrade(a.test, a.answers, recordedIds(a.id));
  const score = T.totalScore(a.test, auto, grading);
  const ret = !!b.returnToStudent;
  db.prepare('UPDATE attempts SET grading = ?, feedback = ?, score = ?, status = ?, returned_at = ? WHERE id = ?').run(
    JSON.stringify(grading),
    String(b.feedback || '').slice(0, 5000),
    score,
    ret ? 'returned' : 'submitted',
    ret ? now() : null,
    a.id,
  );
  return { score, status: ret ? 'returned' : 'submitted' };
});

route('POST', '/api/attempts/:id/unlock', 'teacher', async ({ req, params }) => {
  const a = getAttempt(params.id);
  if (!['locked', 'in_progress'].includes(a.status)) throw new HttpError(409, 'This test is already submitted.');
  const b = await readJson(req);
  const add = Math.min(240, Math.max(0, Number.parseInt(b.addMinutes, 10) || 0));
  const deadline = a.deadline_at ? Math.max(a.deadline_at, now()) + add * 60e3 : null;
  db.prepare("UPDATE attempts SET status = 'in_progress', deadline_at = ? WHERE id = ?").run(
    a.deadline_at ? deadline : null,
    a.id,
  );
  logEvent(a.id, 'unlocked', add ? `+${add} min` : '');
  return { ok: true };
});

route('POST', '/api/attempts/:id/force-submit', 'teacher', ({ params }) => {
  const a = getAttempt(params.id);
  if (!['locked', 'in_progress'].includes(a.status)) throw new HttpError(409, 'This test is already submitted.');
  submitAttempt(a, 'teacher');
  return { ok: true };
});

route('DELETE', '/api/attempts/:id', 'teacher', ({ params }) => {
  const a = getAttempt(params.id);
  deleteRecordingFiles(db.prepare('SELECT file FROM recordings WHERE attempt_id = ?').all(a.id));
  db.prepare('DELETE FROM attempts WHERE id = ?').run(a.id);
  return { ok: true };
});

// --------------------------------------------------------------- students

route('GET', '/api/my/tests', 'student', ({ user }) => {
  sweepExpired();
  const attempts = new Map(
    db.prepare('SELECT * FROM attempts WHERE student_id = ?').all(user.id).map((a) => [a.test_id, a]),
  );
  const tests = db
    .prepare("SELECT * FROM tests WHERE status != 'draft' ORDER BY updated_at DESC")
    .all()
    .map((r) => ({ ...r, data: parse(r.data, null) }))
    .filter((t) => attempts.has(t.id) || testVisibleTo(t, user))
    .map((t) => {
      const a = attempts.get(t.id);
      const snap = a ? parse(a.test_snapshot, t.data) : t.data;
      const show = a?.status === 'returned' && snap.settings.showResults !== 'none';
      return {
        id: t.id,
        title: snap.title,
        timeLimitMin: snap.timeLimitMin,
        extraTimePct: user.extra_time_pct,
        questionCount: snap.questions.filter((q) => q.type !== 'section').length,
        testOpen: t.status === 'open',
        attempt: a
          ? {
              id: a.id,
              status: a.status,
              submittedAt: a.submitted_at,
              score: show ? a.score : null,
              maxScore: show ? a.max_score : null,
              hasDetails: show && snap.settings.showResults === 'full',
            }
          : null,
      };
    });
  return { tests };
});

// The rules shown before starting; does not start the clock.
route('GET', '/api/my/tests/:id/rules', 'student', ({ params, user }) => {
  const t = getTest(params.id);
  const a = db.prepare('SELECT test_snapshot FROM attempts WHERE test_id = ? AND student_id = ?').get(t.id, user.id);
  if (!a && !testVisibleTo(t, user)) throw new HttpError(403, 'This test is not open for you.');
  const data = a ? parse(a.test_snapshot, t.data) : t.data;
  return {
    test: { title: data.title, language: data.language, timeLimitMin: data.timeLimitMin, settings: data.settings },
    accommodations: { readAloud: !!user.read_aloud || data.settings.readAloudForAll, voiceAnswers: canRecord(user, data) },
  };
});

route('POST', '/api/my/tests/:id/start', 'student', async ({ req, params, user }) => {
  const b = await readJson(req);
  const clientId = String(b.clientId || '').slice(0, 64);
  if (!clientId) throw new HttpError(400, 'Missing client id.');
  const t = getTest(params.id);
  sweepExpired();
  const existing = db.prepare('SELECT id FROM attempts WHERE test_id = ? AND student_id = ?').get(t.id, user.id);
  if (existing) {
    const a = getAttempt(existing.id);
    if (!['in_progress', 'locked'].includes(a.status)) throw new HttpError(409, 'You have already submitted this test.');
    if (a.client_id && a.client_id !== clientId) logEvent(a.id, 'reopened', 'Test opened in a new window or device');
    db.prepare('UPDATE attempts SET client_id = ? WHERE id = ?').run(clientId, a.id);
    return studentAttemptPayload({ ...a, client_id: clientId }, user);
  }
  if (!testVisibleTo(t, user)) throw new HttpError(403, 'This test is not open for you.');
  const started = now();
  const limitMs = t.data.timeLimitMin * 60e3 * (1 + user.extra_time_pct / 100);
  const r = db
    .prepare(
      "INSERT INTO attempts (test_id, student_id, status, test_snapshot, started_at, deadline_at, client_id, max_score) VALUES (?, ?, 'in_progress', ?, ?, ?, ?, ?)",
    )
    .run(t.id, user.id, JSON.stringify(t.data), started, limitMs ? Math.round(started + limitMs) : null, clientId, T.maxScore(t.data));
  logEvent(r.lastInsertRowid, 'started');
  return studentAttemptPayload(getAttempt(r.lastInsertRowid), user);
});

route('PUT', '/api/my/attempts/:id/answers', 'student', async ({ req, params, user }) => {
  const a = ownAttempt(params.id, user);
  const b = await readJson(req);
  assertWritable(a, b.clientId);
  const answers = sanitizeAnswers(a.test, b.answers);
  db.prepare('UPDATE attempts SET answers = ? WHERE id = ?').run(JSON.stringify(answers), a.id);
  return { savedAt: now(), deadlineAt: a.deadline_at, serverNow: now() };
});

const COUNTED_EVENTS = new Set(['left', 'fullscreen_exit']);
const LOGGED_EVENTS = new Set(['returned', 'paste_blocked', 'copy_blocked', 'shortcut_blocked', 'fullscreen_refused']);

route('POST', '/api/my/attempts/:id/events', 'student', async ({ req, params, user }) => {
  const a = ownAttempt(params.id, user);
  const b = await readJson(req);
  const type = String(b.type || '');
  if (!COUNTED_EVENTS.has(type) && !LOGGED_EVENTS.has(type)) throw new HttpError(400, 'Unknown event.');
  if (a.status !== 'in_progress' || (a.client_id && b.clientId !== a.client_id)) {
    return { status: a.status, violations: violationCount(a.id) };
  }
  const n = db.prepare('SELECT COUNT(*) AS n FROM events WHERE attempt_id = ?').get(a.id).n;
  if (n < MAX_EVENTS_PER_ATTEMPT) logEvent(a.id, type, b.detail || '', COUNTED_EVENTS.has(type));
  const violations = violationCount(a.id);
  const { maxViolations, onLimit } = a.test.settings;
  let status = a.status;
  if (COUNTED_EVENTS.has(type) && maxViolations > 0 && violations >= maxViolations) {
    if (onLimit === 'lock') {
      db.prepare("UPDATE attempts SET status = 'locked' WHERE id = ?").run(a.id);
      logEvent(a.id, 'locked', `Reached ${maxViolations} warnings`);
      status = 'locked';
    } else if (onLimit === 'submit') {
      submitAttempt(a, 'violations');
      status = 'submitted';
    }
  }
  return { status, violations, maxViolations };
});

route('GET', '/api/my/attempts/:id/status', 'student', ({ params, user }) => {
  sweepExpired();
  const a = ownAttempt(params.id, user);
  return { status: a.status, deadlineAt: a.deadline_at, serverNow: now(), violations: violationCount(a.id) };
});

const AUDIO_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac' };

route('POST', '/api/my/attempts/:id/recordings', 'student', async ({ req, params, query, user }) => {
  const a = ownAttempt(params.id, user);
  assertWritable(a, query.get('clientId'));
  if (!canRecord(user, a.test)) throw new HttpError(403, 'Voice answers are not turned on for you.');
  const qid = query.get('q');
  const q = a.test.questions.find((x) => x.id === qid && x.type !== 'section');
  if (!q) throw new HttpError(400, 'Unknown question.');
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!AUDIO_EXT[mime]) throw new HttpError(415, 'Unsupported audio format.');
  const body = await readBody(req, MAX_AUDIO);
  if (body.length < 100) throw new HttpError(400, 'The recording is empty.');
  const file = `${a.id}-${crypto.randomBytes(8).toString('hex')}.${AUDIO_EXT[mime]}`;
  await fs.promises.writeFile(path.join(REC_DIR, file), body);
  const old = db.prepare('SELECT file FROM recordings WHERE attempt_id = ? AND question_id = ?').all(a.id, qid);
  db.prepare('DELETE FROM recordings WHERE attempt_id = ? AND question_id = ?').run(a.id, qid);
  deleteRecordingFiles(old);
  const duration = Math.min(3600, Math.max(0, Number(query.get('duration')) || 0));
  const r = db
    .prepare('INSERT INTO recordings (attempt_id, question_id, file, mime, size, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(a.id, qid, file, mime, body.length, duration, now());
  return { id: Number(r.lastInsertRowid), questionId: qid, duration };
});

route('DELETE', '/api/my/attempts/:id/recordings/:rid', 'student', ({ params, query, user }) => {
  const a = ownAttempt(params.id, user);
  assertWritable(a, query.get('clientId'));
  const rows = db.prepare('SELECT file FROM recordings WHERE id = ? AND attempt_id = ?').all(Number(params.rid), a.id);
  db.prepare('DELETE FROM recordings WHERE id = ? AND attempt_id = ?').run(Number(params.rid), a.id);
  deleteRecordingFiles(rows);
  return { ok: true };
});

route('POST', '/api/my/attempts/:id/submit', 'student', async ({ req, params, user }) => {
  const a = ownAttempt(params.id, user);
  const b = await readJson(req);
  if (a.status === 'submitted' || a.status === 'returned') return { status: a.status };
  // Past the deadline assertWritable submits what was autosaved and throws.
  assertWritable(a, b.clientId);
  if (b.answers) a.answers = sanitizeAnswers(a.test, b.answers);
  db.prepare('UPDATE attempts SET answers = ? WHERE id = ?').run(JSON.stringify(a.answers), a.id);
  submitAttempt(a, b.reason === 'time' ? 'time' : 'student');
  return { status: 'submitted' };
});

route('GET', '/api/my/attempts/:id/result', 'student', ({ params, user }) => {
  const a = ownAttempt(params.id, user);
  const mode = a.test.settings.showResults;
  if (a.status !== 'returned' || mode === 'none') throw new HttpError(403, 'Your teacher has not shared results yet.');
  const out = { title: a.test.title, score: a.score, maxScore: a.max_score, feedback: a.feedback, mode };
  if (mode === 'full') {
    const auto = T.autoGrade(a.test, a.answers, recordedIds(a.id));
    out.test = a.test;
    out.answers = a.answers;
    out.marks = Object.fromEntries(
      Object.entries(auto).map(([qid, v]) => {
        const g = a.grading[qid] || {};
        return [qid, { points: Number.isFinite(g.points) ? g.points : v.auto, max: v.max, comment: g.comment || '' }];
      }),
    );
    out.recordings = db.prepare('SELECT id, question_id AS questionId FROM recordings WHERE attempt_id = ?').all(a.id);
  }
  return out;
});

// ---------------------------------------------------------- recordings

route('GET', '/api/recordings/:id', 'any', ({ req, res, params, user }) => {
  const r = db
    .prepare('SELECT r.*, a.student_id FROM recordings r JOIN attempts a ON a.id = r.attempt_id WHERE r.id = ?')
    .get(Number(params.id));
  if (!r || (user.role !== 'teacher' && r.student_id !== user.id)) throw new HttpError(404, 'Recording not found.');
  const file = path.join(REC_DIR, r.file);
  const size = fs.statSync(file).size;
  const headers = { 'Content-Type': r.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
  // Safari will not play audio without byte-range support.
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      send(res, 416, '', { 'Content-Range': `bytes */${size}` });
      return undefined;
    }
    res.writeHead(206, { ...SECURITY_HEADERS, ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...SECURITY_HEADERS, ...headers, 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
  return undefined;
});

// ----------------------------------------------------------------- static

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  else if (!path.extname(rel)) rel += '.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    send(res, 200, buf, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
  });
}

// ----------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  }
  try {
    // Custom header = cross-site forms and simple requests can't reach the API.
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch')
      throw new HttpError(403, 'Forbidden.');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let user = null;
      if (r.role) {
        user = currentUser(req);
        if (!user) throw new HttpError(401, 'Please log in.');
        if (r.role !== 'any' && user.role !== r.role) throw new HttpError(403, 'Not allowed.');
      }
      const out = await r.handler({ req, res, params, query: url.searchParams, user });
      if (out !== undefined) sendJson(res, 200, out);
      return;
    }
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (e instanceof T.ValidationError) e.status = 400;
    if (!e.status) console.error(e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
    else res.destroy();
  }
});

if (require.main === module) {
  refreshSetupCode();
  setInterval(() => {
    sweepExpired();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  }, 20e3).unref();
  server.listen(PORT, () => console.log(`Online tests running on http://localhost:${PORT}  (data: ${DATA_DIR})`));
}

module.exports = { server, db, refreshSetupCode };
