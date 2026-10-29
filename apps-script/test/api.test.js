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

function setup({ classroom } = {}) {
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
    classroom,
  });
  // The person who set up the app is the admin.
  const teacher = { id: 'teacher@school.org', email: 'teacher@school.org', role: 'teacher', admin: true };
  const otherTeacher = (email) => ({ id: email, email, role: 'teacher', admin: false });
  // Mirrors Main.currentUser_: a student record makes you a student.
  const asStudent = (email) => {
    const s = db.get('students', email);
    if (!s) return { id: email, email, role: 'guest' };
    return { id: email, email, role: 'student', name: s.name, readAloud: s.readAloud, voiceAnswers: s.voiceAnswers, extraTimePct: s.extraTimePct };
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
  const addClass = (user, name, people) => {
    const id = call(user, 'POST', '/api/classes', { name }).body.id;
    if (people) call(user, 'POST', `/api/classes/${id}/students`, { people });
    return id;
  };
  return { db, drive, api, teacher, otherTeacher, asStudent, addClass, call, tick: (ms) => (clock += ms) };
}

test('full flow: roster, test, attempt, warnings, recording, grading, results', () => {
  const { db, drive, teacher, asStudent, addClass, call } = setup();

  const c103 = addClass(teacher, '10-3');
  const c104 = addClass(teacher, '10-4', [{ email: 'yoni@school.org', name: 'Yoni' }]);
  const added = call(teacher, 'POST', `/api/classes/${c103}/students`, {
    people: [
      { email: 'Dana@School.org', name: 'Dana Levi' },
      { email: 'not-an-email', name: 'X' },
    ],
  });
  assert.equal(added.body.added, 1);
  assert.equal(added.body.skipped.length, 1);
  call(teacher, 'PUT', '/api/students/dana@school.org', { voiceAnswers: true, readAloud: true, extraTimePct: 25 });

  // A student can't use teacher routes; someone not on the roster can't do anything.
  const dana = asStudent('dana@school.org');
  const yoni = asStudent('yoni@school.org');
  assert.equal(call(dana, 'GET', '/api/tests').status, 403);
  assert.equal(call({ role: 'guest', email: 'x@school.org' }, 'GET', '/api/my/tests').status, 403);

  const testId = call(teacher, 'POST', '/api/tests', { data: { ...sample, classIds: [c103, 'not-mine'] } }).body.id;
  assert.deepEqual(call(teacher, 'GET', `/api/tests/${testId}`).body.data.classIds, [c103], 'unknown classes dropped');
  assert.ok(c104);
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
  const { teacher, asStudent, addClass, call, tick } = setup();
  addClass(teacher, 'A', [{ email: 's@school.org', name: 'S' }]);
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
  const { teacher, otherTeacher, asStudent, addClass, call } = setup();
  addClass(teacher, 'A', [{ email: 's@school.org' }]);
  assert.equal(asStudent('s@school.org').name, 's', 'name defaults to the email');
  const data = { ...sample, settings: { ...sample.settings, maxViolations: 1, onLimit: 'submit' } };
  const id = call(teacher, 'POST', '/api/tests', { data }).body.id;
  call(teacher, 'PUT', `/api/tests/${id}`, { status: 'open' });
  const s = asStudent('s@school.org');
  const a = call(s, 'POST', `/api/my/tests/${id}/start`, { clientId: 'c' }).body.attempt;
  assert.equal(call(s, 'POST', `/api/my/attempts/${a.id}/events`, { clientId: 'c', type: 'left' }).body.status, 'submitted');

  assert.equal(call(teacher, 'POST', '/api/teachers', { email: 'Other@School.org' }).status, 200);
  assert.deepEqual(call(teacher, 'GET', '/api/teachers').body.teachers.map((t) => t.email), ['teacher@school.org', 'other@school.org']);
  assert.equal(call(teacher, 'DELETE', '/api/teachers/teacher@school.org').status, 400);
  assert.equal(call(otherTeacher('other@school.org'), 'GET', '/api/teachers').status, 403, 'only the admin manages teachers');
  assert.equal(call(otherTeacher('other@school.org'), 'PUT', '/api/settings', { recorderUrl: '' }).status, 403);

  assert.equal(call(teacher, 'PUT', '/api/settings', { recorderUrl: 'javascript:alert(1)' }).status, 400);
  assert.equal(call(teacher, 'PUT', '/api/settings', { recorderUrl: 'https://example.org/rec.html' }).body.recorderUrl, 'https://example.org/rec.html');
});


test('multiple correct answers: partial and all-or-nothing marking', () => {
  const { teacher, asStudent, addClass, call } = setup();
  addClass(teacher, 'A', [{ email: 's@school.org', name: 'S' }]);
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

test("teacher can see a student's home page", () => {
  const { teacher, asStudent, addClass, call } = setup();
  const c91 = addClass(teacher, '9-1', [{ email: 'a@school.org', name: 'A' }]);
  const c92 = addClass(teacher, '9-2');
  call(teacher, 'PUT', '/api/students/a@school.org', { extraTimePct: 50 });
  const open = call(teacher, 'POST', '/api/tests', { data: { ...sample, classIds: [c91] } }).body.id;
  const other = call(teacher, 'POST', '/api/tests', { data: { ...sample, title: 'Other class', classIds: [c92] } }).body.id;
  call(teacher, 'PUT', `/api/tests/${open}`, { status: 'open' });
  call(teacher, 'PUT', `/api/tests/${other}`, { status: 'open' });
  const home = call(teacher, 'GET', '/api/students/a@school.org/home').body;
  assert.equal(home.student.name, 'A');
  assert.deepEqual(home.tests.map((t) => t.id), [open]);
  assert.equal(home.tests[0].extraTimePct, 50);
  assert.deepEqual(home.tests, call(asStudent('a@school.org'), 'GET', '/api/my/tests').body.tests);
  assert.deepEqual(call(asStudent('a@school.org'), 'GET', '/api/my/tests').body.classes, [{ name: '9-1', status: 'active' }]);
  assert.equal(call(asStudent('a@school.org'), 'GET', '/api/students/a@school.org/home').status, 403);
});

test('teachers only see their own classes, tests, students and results', () => {
  const { teacher, otherTeacher, asStudent, addClass, call } = setup();
  call(teacher, 'POST', '/api/teachers', { email: 'ruth@school.org' });
  const ruth = otherTeacher('ruth@school.org');
  const mineC = addClass(teacher, 'Mine', [{ email: 'a@school.org', name: 'A' }]);
  const ruthC = addClass(ruth, 'Ruth 11-2', [{ email: 'b@school.org', name: 'B' }, { email: 'a@school.org' }]);
  const mineT = call(teacher, 'POST', '/api/tests', { data: sample }).body.id;
  const ruthT = call(ruth, 'POST', '/api/tests', { data: { ...sample, title: 'Ruth quiz', classIds: [mineC] } }).body.id;
  assert.deepEqual(call(ruth, 'GET', `/api/tests/${ruthT}`).body.data.classIds, [], "can't put a test on someone else's class");
  call(teacher, 'PUT', `/api/tests/${mineT}`, { status: 'open' });
  call(ruth, 'PUT', `/api/tests/${ruthT}`, { status: 'open' });

  assert.deepEqual(call(ruth, 'GET', '/api/tests').body.tests.map((t) => t.title), ['Ruth quiz']);
  assert.equal(call(teacher, 'GET', '/api/tests').body.tests.length, 2, 'the admin sees everything');
  assert.deepEqual(call(ruth, 'GET', '/api/classes').body.classes.map((c) => c.name), ['Ruth 11-2']);
  assert.equal(call(ruth, 'GET', `/api/tests/${mineT}`).status, 404);
  assert.equal(call(ruth, 'PUT', `/api/classes/${mineC}`, { name: 'x' }).status, 404);
  assert.equal(call(ruth, 'PUT', '/api/students/a@school.org', { extraTimePct: 25 }).status, 200, 'shared student');
  assert.equal(call(otherTeacher('x@school.org'), 'PUT', '/api/students/b@school.org', { extraTimePct: 25 }).status, 404);
  assert.equal(call(ruth, 'DELETE', '/api/students/b@school.org').status, 403, 'only the admin deletes students');

  // A student in both teachers' classes sees both tests; B only Ruth's.
  assert.deepEqual(call(asStudent('a@school.org'), 'GET', '/api/my/tests').body.tests.map((t) => t.title).sort(), [sample.title, 'Ruth quiz'].sort());
  assert.deepEqual(call(asStudent('b@school.org'), 'GET', '/api/my/tests').body.tests.map((t) => t.title), ['Ruth quiz']);
  // Ruth's view of a student's page shows only her tests.
  assert.deepEqual(call(ruth, 'GET', '/api/students/a@school.org/home').body.tests.map((t) => t.title), ['Ruth quiz']);

  const att = call(asStudent('a@school.org'), 'POST', `/api/my/tests/${mineT}/start`, { clientId: 'c' }).body.attempt.id;
  assert.equal(call(ruth, 'GET', `/api/attempts/${att}`).status, 404, "can't open another teacher's results");
  assert.equal(call(teacher, 'GET', `/api/attempts/${att}`).status, 200);
  assert.equal(call(ruth, 'GET', `/api/tests/${ruthT}/attempts`).body.notStarted.map((s) => s.id).sort().join(), 'a@school.org,b@school.org');
  assert.ok(ruthC);
});

test('join codes: open, needs approval, off', () => {
  const { teacher, asStudent, addClass, call } = setup();
  const c = addClass(teacher, 'English 10');
  const code = call(teacher, 'GET', '/api/classes').body.classes[0].joinCode;
  assert.match(code, /^ENG-\d{4}$/);
  const guest = asStudent('new@school.org');
  assert.equal(guest.role, 'guest');
  assert.equal(call(guest, 'POST', '/api/join', { code, name: 'New Kid' }).status, 404, 'joining is off by default');

  call(teacher, 'PUT', `/api/classes/${c}`, { joinMode: 'open' });
  assert.equal(call(guest, 'POST', '/api/join', { code: code.toLowerCase().replace('-', ' '), name: '' }).status, 400, 'a name is needed');
  const joined = call(guest, 'POST', '/api/join', { code: code.toLowerCase().replace('-', ' '), name: 'New Kid' }).body;
  assert.deepEqual(joined, { className: 'English 10', status: 'active' });
  assert.equal(asStudent('new@school.org').name, 'New Kid');

  call(teacher, 'PUT', `/api/classes/${c}`, { joinMode: 'approve', newCode: true });
  const code2 = call(teacher, 'GET', '/api/classes').body.classes[0].joinCode;
  assert.notEqual(code2, code);
  assert.equal(call(asStudent('late@school.org'), 'POST', '/api/join', { code, name: 'Late' }).status, 404, 'old code stops working');
  assert.equal(call(asStudent('late@school.org'), 'POST', '/api/join', { code: code2, name: 'Late Kid' }).body.status, 'pending');
  const t = call(teacher, 'POST', '/api/tests', { data: sample }).body.id;
  call(teacher, 'PUT', `/api/tests/${t}`, { status: 'open' });
  assert.equal(call(asStudent('late@school.org'), 'GET', '/api/my/tests').body.tests.length, 0, 'pending students see no tests');
  const cls = call(teacher, 'GET', '/api/classes').body.classes[0];
  assert.equal(cls.students[0].status, 'pending', 'pending listed first');
  call(teacher, 'POST', `/api/classes/${c}/students/late@school.org/approve`);
  assert.equal(call(asStudent('late@school.org'), 'GET', '/api/my/tests').body.tests.length, 1);
  assert.equal(call(teacher, 'POST', '/api/join', { code: code2 }).status, 400, 'teachers do not join');

  call(teacher, 'DELETE', `/api/classes/${c}/students/new@school.org`);
  assert.equal(call(asStudent('new@school.org'), 'GET', '/api/my/tests').body.tests.length, 0);
});

test('Google Classroom import (owner only)', () => {
  const classroom = {
    courses: () => [{ id: 'c1', name: 'English 10-3', section: 'Morning' }],
    students: (id) => (id === 'c1' ? [{ email: 'Dana@School.org', name: 'Dana Levi' }, { email: '', name: 'Hidden Email' }, { email: 'yoni@school.org', name: 'Yoni' }] : []),
  };
  const { teacher, otherTeacher, asStudent, addClass, call } = setup({ classroom });
  const c = addClass(teacher, '10-3');
  assert.equal(call(teacher, 'GET', '/api/classes').body.classroomAvailable, true);
  assert.equal(call(teacher, 'GET', '/api/classroom/courses').body.courses[0].name, 'English 10-3');
  const r = call(teacher, 'POST', `/api/classes/${c}/classroom`, { courseId: 'c1' }).body;
  assert.equal(r.added, 2);
  assert.equal(r.skipped.length, 1);
  assert.equal(asStudent('dana@school.org').name, 'Dana Levi');
  assert.equal(call(teacher, 'GET', '/api/classes').body.classes[0].classroomId, 'c1');
  assert.equal(call(teacher, 'POST', `/api/classes/${c}/classroom`, {}).body.total, 3, 're-sync uses the saved course');

  call(teacher, 'POST', '/api/teachers', { email: 'ruth@school.org' });
  const ruth = otherTeacher('ruth@school.org');
  assert.equal(call(ruth, 'GET', '/api/classes').body.classroomAvailable, false);
  assert.equal(call(ruth, 'GET', '/api/classroom/courses').status, 403);
});

test('upgrade from the single-teacher version keeps everything', () => {
  const { db, api, teacher, asStudent, call } = setup();
  // Data as the previous version left it: class names on students and tests.
  db.insert('students', { id: 'dana@school.org', name: 'Dana Levi', className: '10-3', readAloud: true, voiceAnswers: true, extraTimePct: 25 });
  db.insert('students', { id: 'yoni@school.org', name: 'Yoni', className: '10-4' });
  db.insert('students', { id: 'noclass@school.org', name: 'No Class', className: '' });
  const data = normalizeTest({ ...sample, classes: ['10-3'] });
  delete data.classIds;
  db.insert('tests', { id: 't1', ownerId: 'teacher@school.org', title: data.title, status: 'open', data, updatedAt: 1 });
  const allData = normalizeTest(sample);
  delete allData.classIds;
  db.insert('tests', { id: 't2', ownerId: '', title: 'For everyone', status: 'open', data: { ...allData, title: 'For everyone' }, updatedAt: 2 });
  db.insert('attempts', { id: 'a1', testId: 't1', studentId: 'dana@school.org', status: 'returned', snapshot: data, answers: { a1: 1 }, grading: {}, score: 17.5, maxScore: 100 });

  api.migrate();
  api.migrate(); // running twice changes nothing

  const classes = call(teacher, 'GET', '/api/classes').body.classes;
  assert.deepEqual(classes.map((c) => [c.name, c.students.map((s) => s.id)]), [
    ['10-3', ['dana@school.org']],
    ['10-4', ['yoni@school.org']],
    ['My students', ['noclass@school.org']],
  ]);
  assert.equal(db.get('tests', 't2').ownerId, 'teacher@school.org');
  assert.deepEqual(db.get('tests', 't1').data.classIds, [classes[0].id]);
  assert.deepEqual(db.get('tests', 't2').data.classIds, []);
  // Dana still sees her graded test and her score; Yoni sees only the test for everyone.
  const dana = call(asStudent('dana@school.org'), 'GET', '/api/my/tests').body.tests;
  assert.equal(dana.find((t) => t.id === 't1').attempt.score, 17.5);
  assert.deepEqual(call(asStudent('yoni@school.org'), 'GET', '/api/my/tests').body.tests.map((t) => t.id), ['t2']);
  assert.equal(asStudent('dana@school.org').extraTimePct, 25, 'accommodations kept');
  assert.equal(db.get('attempts', 'a1').score, 17.5, 'results untouched');
});

test('matching (Module E vocabulary): per-match points, key hidden from students', () => {
  const { teacher, asStudent, addClass, call } = setup();
  addClass(teacher, 'A', [{ email: 's@school.org', name: 'S' }]);
  const data = {
    title: 'Vocabulary',
    questions: [
      {
        id: 'm1',
        type: 'match',
        prompt: 'Match three of the items 1–6 to the definitions.',
        items: ['a calendar', 'a season', 'an island', 'traffic', 'a prize', 'a label'],
        pairs: [
          { text: 'cars, buses, and trucks moving along a road', answer: 3 },
          { text: 'shows days, weeks, and months in a year', answer: 0 },
          { text: 'something you are given when you win a race', answer: 4 },
        ],
        pointsEach: 2,
      },
    ],
  };
  const id = call(teacher, 'POST', '/api/tests', { data }).body.id;
  const saved = call(teacher, 'GET', `/api/tests/${id}`).body.data.questions[0];
  assert.equal(saved.points, 6, 'total = 2 per match × 3');
  call(teacher, 'PUT', `/api/tests/${id}`, { status: 'open' });
  const s = asStudent('s@school.org');
  const start = call(s, 'POST', `/api/my/tests/${id}/start`, { clientId: 'c' }).body;
  assert.deepEqual(start.test.questions[0].pairs, data.questions[0].pairs.map((p) => ({ text: p.text })), 'answers not sent');
  const a = start.attempt.id;
  call(s, 'PUT', `/api/my/attempts/${a}/answers`, { clientId: 'c', answers: { m1: [3, 1, 'x', 9] } });
  call(s, 'POST', `/api/my/attempts/${a}/submit`, { clientId: 'c' });
  const d = call(teacher, 'GET', `/api/attempts/${a}`).body;
  assert.deepEqual(d.attempt.answers.m1, [3, 1, null], 'bad picks dropped, one per definition');
  assert.equal(d.auto.m1.auto, 2, 'one correct match');
  assert.equal(core.autoGrade({ questions: [saved] }, { m1: [null, null, null] }, new Set()).m1.auto, 0);
  assert.equal(core.autoGrade({ questions: [saved] }, { m1: [3, 0, 4] }, new Set()).m1.auto, 6);
  assert.throws(() => core.normalizeTest({ title: 'x', questions: [{ type: 'match', items: ['only one'], pairs: [{ text: 't', answer: 0 }] }] }), /at least two items/);
});
