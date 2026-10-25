'use strict';
// Runs the Apps Script server code in Node against in-memory fakes of the
// spreadsheet and Drive.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/server/Core.js');
Object.assign(globalThis, core);
const { createApi, HttpError } = require('../src/server/Api.js');
globalThis.HttpError = HttpError;

const sample = require('../samples/past-simple-vs-past-progressive.json');

const { MemoryStore } = require('./memory-store.js');

function setup() {
  const db = new MemoryStore();
  const drive = new Map();
  let clock = 1_700_000_000_000;
  let settings = {};
  const api = createApi({
    db,
    ownerEmail: 'teacher@school.org',
    now: () => clock,
    withLock: (fn) => fn(),
    files: {
      save: (name, mime, data) => (drive.set(name, data), name),
      read: (id) => drive.get(id),
      remove: (id) => drive.delete(id),
    },
    exportResults: (title, rows) => `sheet:${title}:${rows.length}`,
    settings: { get: () => ({ recorderUrl: settings.recorderUrl || 'default' }), set: (s) => (settings = s) },
  });
  const teacher = { id: 'teacher@school.org', role: 'teacher' };
  const asStudent = (email) => {
    const s = db.get('students', email);
    return { id: email, role: 'student', name: s.name, className: s.className, readAloud: s.readAloud, voiceAnswers: s.voiceAnswers, extraTimePct: s.extraTimePct };
  };
  const call = (user, method, path, body) => {
    try {
      return { status: 200, body: api.handle(method, path, body, user) };
    } catch (e) {
      if (e instanceof core.ValidationError) return { status: 400, body: { error: e.message } };
      if (!e.status) throw e;
      return { status: e.status, body: { error: e.message } };
    }
  };
  return { db, drive, api, teacher, asStudent, call, tick: (ms) => (clock += ms) };
}

test('full flow: roster, test, attempt, warnings, recording, grading, results', () => {
  const { db, drive, teacher, asStudent, call, tick } = setup();

  const added = call(teacher, 'POST', '/api/students/bulk', {
    people: [
      { email: 'Dana@School.org', name: 'Dana Levi', className: '10-3' },
      { email: 'yoni@school.org', name: 'Yoni', className: '10-4' },
      { email: 'not-an-email', name: 'X' },
    ],
  });
  assert.equal(added.body.added, 2);
  assert.equal(added.body.skipped.length, 1);
  call(teacher, 'PUT', '/api/students/dana@school.org', { voiceAnswers: true, readAloud: true, extraTimePct: 25 });

  // A student can't use teacher routes; someone not on the roster can't do anything.
  const dana = asStudent('dana@school.org');
  const yoni = asStudent('yoni@school.org');
  assert.equal(call(dana, 'GET', '/api/tests').status, 403);
  assert.equal(call({ role: null, email: 'x@school.org' }, 'GET', '/api/my/tests').status, 403);

  const testId = call(teacher, 'POST', '/api/tests', { data: { ...sample, classes: ['10-3'] } }).body.id;
  assert.equal(call(dana, 'GET', '/api/my/tests').body.tests.length, 0, 'drafts are hidden');
  call(teacher, 'PUT', `/api/tests/${testId}`, { status: 'open' });
  assert.equal(call(dana, 'GET', '/api/my/tests').body.tests.length, 1);
  assert.equal(call(yoni, 'GET', '/api/my/tests').body.tests.length, 0, 'other class');
  assert.equal(call(yoni, 'POST', `/api/my/tests/${testId}/start`, { clientId: 'x' }).status, 403);

  assert.equal(call(dana, 'GET', `/api/my/tests/${testId}/rules`).body.accommodations.voiceAnswers, true);
  const start = call(dana, 'POST', `/api/my/tests/${testId}/start`, { clientId: 'tab1' }).body;
  const attemptId = start.attempt.id;
  assert.equal((start.attempt.deadlineAt - start.attempt.startedAt) / 60000, 25 * 1.25, 'extra time');
  assert.ok(start.test.questions.every((q) => q.correct === undefined && q.accepted === undefined), 'no answer key sent');

  const answers = { a1: 1, a2: 1, b1: 'Went.', b3: 'was rained', c4: 'Correct', d1: 'My brother was sleeping when the alarm went off.', zzz: 'ignored', a3: 99 };
  assert.equal(call(dana, 'PUT', `/api/my/attempts/${attemptId}/answers`, { clientId: 'tab1', answers }).status, 200);
  assert.deepEqual(Object.keys(db.get('attempts', attemptId).answers).sort(), ['a1', 'a2', 'b1', 'b3', 'c4', 'd1']);

  // Second window takes over.
  call(dana, 'POST', `/api/my/tests/${testId}/start`, { clientId: 'tab2' });
  assert.equal(call(dana, 'PUT', `/api/my/attempts/${attemptId}/answers`, { clientId: 'tab1', answers }).status, 409);

  const rec = call(dana, 'POST', `/api/my/attempts/${attemptId}/recordings`, { clientId: 'tab2', questionId: 'd2', mime: 'audio/webm;codecs=opus', data: 'A'.repeat(500), duration: 4.2 });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal(call(yoni, 'GET', `/api/recordings/${rec.body.id}`).status, 404, 'other students cannot hear it');
  assert.equal(call(teacher, 'GET', `/api/recordings/${rec.body.id}`).body.data.length, 500);
  assert.equal(call(yoni, 'POST', `/api/my/attempts/${attemptId}/recordings`, { clientId: 'tab2', questionId: 'd2', mime: 'audio/webm', data: 'A'.repeat(500) }).status, 404);

  // Three warnings -> paused.
  for (const type of ['left', 'paste_blocked', 'left']) assert.equal(call(dana, 'POST', `/api/my/attempts/${attemptId}/events`, { clientId: 'tab2', type }).body.status, 'in_progress');
  const third = call(dana, 'POST', `/api/my/attempts/${attemptId}/events`, { clientId: 'tab2', type: 'fullscreen_exit' }).body;
  assert.equal(third.status, 'locked');
  assert.equal(third.violations, 3);
  assert.equal(call(dana, 'PUT', `/api/my/attempts/${attemptId}/answers`, { clientId: 'tab2', answers }).status, 423);
  assert.equal(call(dana, 'POST', `/api/my/attempts/${attemptId}/events`, { clientId: 'tab2', type: 'nonsense' }).status, 400);

  const list = call(teacher, 'GET', `/api/tests/${testId}/attempts`).body;
  assert.equal(list.attempts[0].status, 'locked');
  assert.equal(list.attempts[0].name, 'Dana Levi');
  assert.equal(list.notStarted.length, 0);
  call(teacher, 'POST', `/api/attempts/${attemptId}/unlock`, { addMinutes: 5 });

  assert.equal(call(dana, 'POST', `/api/my/attempts/${attemptId}/submit`, { clientId: 'tab2', answers }).body.status, 'submitted');
  assert.equal(call(dana, 'POST', `/api/my/tests/${testId}/start`, { clientId: 'tab3' }).status, 409);

  const detail = call(teacher, 'GET', `/api/attempts/${attemptId}`).body;
  const auto = detail.auto;
  assert.equal(auto.a1.auto, 4);
  assert.equal(auto.a2.auto, 0);
  assert.equal(auto.b1.auto, 3, 'case and full stop ignored');
  assert.equal(auto.b3.auto, 0);
  assert.equal(auto.b3.review, true);
  assert.equal(auto.c4.auto, 4);
  assert.equal(auto.d1.auto, null);
  assert.equal(auto.d2.auto, null, 'voice answer needs teacher');
  assert.equal(detail.attempt.score, 11);
  assert.ok(detail.events.some((e) => e.type === 'reopened'));

  assert.equal(call(dana, 'GET', `/api/my/attempts/${attemptId}/result`).status, 403, 'hidden until returned');
  const graded = call(teacher, 'PUT', `/api/attempts/${attemptId}/grade`, {
    grading: { d1: { points: 2, comment: 'Nice' }, d2: { points: 1.5 }, b3: { points: 99 } },
    feedback: 'Good work',
    returnToStudent: true,
  }).body;
  assert.equal(graded.score, 11 + 2 + 1.5 + 3, 'marks clamp to the maximum');
  const result = call(dana, 'GET', `/api/my/attempts/${attemptId}/result`).body;
  assert.equal(result.marks.d1.comment, 'Nice');
  assert.equal(result.feedback, 'Good work');
  const mine = call(dana, 'GET', '/api/my/tests').body.tests[0];
  assert.equal(mine.attempt.score, 17.5);
  assert.equal(mine.attempt.hasDetails, true);

  assert.equal(call(teacher, 'POST', `/api/tests/${testId}/export`).body.url, `sheet:${sample.title}:2`);

  // Retake removes the attempt, its events and the Drive file.
  assert.equal(drive.size, 1);
  call(teacher, 'DELETE', `/api/attempts/${attemptId}`);
  assert.equal(drive.size, 0);
  assert.equal(db.all('events').length, 0);
  assert.equal(call(dana, 'GET', `/api/my/tests/${testId}/rules`).status, 200);
});

test('time limit: an abandoned attempt is submitted with its saved answers', () => {
  const { teacher, asStudent, call, tick } = setup();
  call(teacher, 'POST', '/api/students/bulk', { people: [{ email: 's@school.org', name: 'S' }] });
  const id = call(teacher, 'POST', '/api/tests', { data: { ...sample, timeLimitMin: 10 } }).body.id;
  call(teacher, 'PUT', `/api/tests/${id}`, { status: 'open' });
  const s = asStudent('s@school.org');
  const a = call(s, 'POST', `/api/my/tests/${id}/start`, { clientId: 'c' }).body.attempt;
  call(s, 'PUT', `/api/my/attempts/${a.id}/answers`, { clientId: 'c', answers: { a1: 1 } });
  tick(11 * 60e3);
  assert.equal(call(s, 'PUT', `/api/my/attempts/${a.id}/answers`, { clientId: 'c', answers: { a1: 0 } }).status, 409);
  const row = call(teacher, 'GET', `/api/tests/${id}/attempts`).body.attempts[0];
  assert.equal(row.status, 'submitted');
  assert.equal(row.submitReason, 'time');
  assert.equal(row.score, 4, 'the saved answer counted, the late one did not');
});

test('auto-submit after warnings, teachers, settings', () => {
  const { teacher, asStudent, call } = setup();
  call(teacher, 'POST', '/api/students/bulk', { people: [{ email: 's@school.org' }] });
  assert.equal(asStudent('s@school.org').name, 's', 'name defaults to the email');
  const data = { ...sample, settings: { ...sample.settings, maxViolations: 1, onLimit: 'submit' } };
  const id = call(teacher, 'POST', '/api/tests', { data }).body.id;
  call(teacher, 'PUT', `/api/tests/${id}`, { status: 'open' });
  const s = asStudent('s@school.org');
  const a = call(s, 'POST', `/api/my/tests/${id}/start`, { clientId: 'c' }).body.attempt;
  assert.equal(call(s, 'POST', `/api/my/attempts/${a.id}/events`, { clientId: 'c', type: 'left' }).body.status, 'submitted');

  assert.equal(call(teacher, 'POST', '/api/teachers', { email: 'Other@School.org' }).status, 200);
  assert.deepEqual(call(teacher, 'GET', '/api/users').body.teachers.map((t) => t.email), ['teacher@school.org', 'other@school.org']);
  assert.equal(call(teacher, 'DELETE', '/api/teachers/teacher@school.org').status, 400);

  assert.equal(call(teacher, 'PUT', '/api/settings', { recorderUrl: 'javascript:alert(1)' }).status, 400);
  assert.equal(call(teacher, 'PUT', '/api/settings', { recorderUrl: 'https://example.org/rec.html' }).body.recorderUrl, 'https://example.org/rec.html');
});

test('JSON fields are split across columns and survive the round trip', () => {
  const { parseSchema } = require('../src/server/Store.js');
  const s = parseSchema(['id', 'n:num', 'big:json:3', 'b:bool']);
  assert.equal(s.width, 6);
  assert.deepEqual(s.fields.map((f) => [f.name, f.col, f.width]), [['id', 1, 1], ['n', 2, 1], ['big', 3, 3], ['b', 6, 1]]);
});

test('multiple correct answers: partial and all-or-nothing marking', () => {
  const { teacher, asStudent, call } = setup();
  call(teacher, 'POST', '/api/students/bulk', { people: [{ email: 's@school.org', name: 'S' }] });
  const data = {
    title: 'Two answers',
    questions: [
      { id: 'p', type: 'mc', multiple: true, prompt: 'Choose TWO', options: ['a', 'b', 'c', 'd'], correct: [3, 1, 1], points: 4 },
      { id: 'q', type: 'mc', multiple: true, scoring: 'all', prompt: 'Choose TWO', options: ['a', 'b', 'c', 'd'], correct: [0, 2], points: 4 },
      { id: 'r', type: 'mc', multiple: true, prompt: 'Choose TWO', options: ['a', 'b', 'c'], correct: [0, 1], points: 3 },
    ],
  };
  const created = call(teacher, 'POST', '/api/tests', { data });
  const id = created.body.id;
  const saved = call(teacher, 'GET', `/api/tests/${id}`).body.data.questions[0];
  assert.deepEqual(saved.correct, [1, 3], 'deduplicated and sorted');
  assert.equal(saved.scoring, 'partial');
  call(teacher, 'PUT', `/api/tests/${id}`, { status: 'open' });
  const s = asStudent('s@school.org');
  const start = call(s, 'POST', `/api/my/tests/${id}/start`, { clientId: 'c' }).body;
  assert.equal(start.test.questions[0].choose, 2, 'students see how many to choose');
  assert.equal(start.test.questions[0].correct, undefined, 'but not which');
  const a = start.attempt.id;
  // p: one right one wrong -> half; q: one right -> 0 (all or nothing); r: three picks for two -> rejected
  call(s, 'PUT', `/api/my/attempts/${a}/answers`, { clientId: 'c', answers: { p: [1, 0], q: [0], r: [0, 1, 2] } });
  call(s, 'POST', `/api/my/attempts/${a}/submit`, { clientId: 'c' });
  const d = call(teacher, 'GET', `/api/attempts/${a}`).body;
  assert.deepEqual(d.attempt.answers, { p: [1, 0], q: [0] });
  assert.equal(d.auto.p.auto, 2);
  assert.equal(d.auto.q.auto, 0);
  assert.equal(d.auto.r.auto, 0);
  assert.equal(d.auto.r.review, false);
  assert.equal(core.autoGrade(data.questions && { questions: [{ ...saved, points: 3, correct: [0, 1, 2] }] }, { p: [0, 1] }, new Set()).p.auto, 2);
});
