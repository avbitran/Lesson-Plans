'use strict';
// SheetStore against an imitation of Google Sheets, including a sheet laid out
// exactly like the previous version's, so updates never misread old data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

globalThis.Utilities = { getUuid: () => crypto.randomUUID() };
globalThis.HttpError = class extends Error {};
const { SheetStore } = require('../src/server/Store.js');
const { FakeSpreadsheet } = require('./fake-sheets.js');

// The column layout written by the version before this change.
const OLD_HEADERS = {
  students: ['id', 'name', 'className', 'readAloud', 'voiceAnswers', 'extraTimePct'],
  teachers: ['id'],
  attempts: ['id', 'testId', 'studentId', 'status', 'startedAt', 'deadlineAt', 'submittedAt', 'submitReason', 'score', 'maxScore', 'returnedAt', 'clientId', 'violations', 'feedback',
    'answers#1', 'answers#2', 'answers#3', 'answers#4', 'grading#1', 'grading#2', ...Array.from({ length: 8 }, (_, i) => `snapshot#${i + 1}`)],
};

function oldSheet(ss, name, rows) {
  const sh = ss.insertSheet(name);
  sh.maxCols = Math.max(26, OLD_HEADERS[name].length);
  sh.cells.push(OLD_HEADERS[name].slice());
  for (const r of rows) sh.cells.push(r);
  return sh;
}

test('reads data written by the previous version and adds new columns at the end', () => {
  const ss = new FakeSpreadsheet();
  oldSheet(ss, 'students', [['dana@school.org', 'Dana Levi', '10-3', true, false, 25]]);
  oldSheet(ss, 'teachers', [['colleague@school.org']]);
  const snapshot = { title: 'Quiz', questions: [{ id: 'a1', type: 'mc', options: ['x', 'y'], correct: 1, points: 4 }], settings: {} };
  const snapText = JSON.stringify(snapshot);
  const answers = JSON.stringify({ a1: 1, b1: 'went' });
  const attempt = ['att1', 'test1', 'dana@school.org', 'returned', 1000, 2000, 1500, 'student', 17.5, 100, 1600, 'tab', 2, 'Good work',
    answers.slice(0, 10), answers.slice(10), '', '', '{"d1":{"points":2,"comment":"Nice"}}', '', snapText.slice(0, 20), snapText.slice(20), '', '', '', '', '', ''];
  const attemptsSheet = oldSheet(ss, 'attempts', [attempt]);

  const db = new SheetStore(ss);
  const s = db.get('students', 'dana@school.org');
  assert.deepEqual(s, { id: 'dana@school.org', name: 'Dana Levi', className: '10-3', readAloud: true, voiceAnswers: false, extraTimePct: 25, createdAt: null });
  const a = db.get('attempts', 'att1');
  assert.deepEqual(a.answers, { a1: 1, b1: 'went' });
  assert.deepEqual(a.grading, { d1: { points: 2, comment: 'Nice' } });
  assert.deepEqual(a.snapshot, snapshot);
  assert.equal(a.score, 17.5);
  assert.equal(a.feedback, 'Good work');
  assert.equal(db.all('attempts', true)[0].violations, 2);
  assert.deepEqual(db.all('teachers'), [{ id: 'colleague@school.org', name: '', addedAt: null }]);

  // New fields were appended, the old columns are untouched.
  assert.deepEqual(ss.getSheetByName('students').cells[0], [...OLD_HEADERS.students, 'createdAt']);
  assert.deepEqual(ss.getSheetByName('teachers').cells[0], ['id', 'name', 'addedAt']);
  assert.deepEqual(attemptsSheet.cells[0], OLD_HEADERS.attempts);
  assert.deepEqual(attemptsSheet.cells[1].slice(0, attempt.length), attempt);

  // Updating writes only the named field, in the right place.
  db.update('students', 'dana@school.org', { createdAt: 5, extraTimePct: 50 });
  assert.deepEqual(ss.getSheetByName('students').cells[1], ['dana@school.org', 'Dana Levi', '10-3', true, false, 50, 5]);
});

test('works when columns are in a different order or extra columns exist', () => {
  const ss = new FakeSpreadsheet();
  const sh = ss.insertSheet('students');
  sh.cells.push(['note', 'name', 'id', 'extraTimePct', 'className', 'readAloud', 'voiceAnswers', 'createdAt']);
  sh.cells.push(['teacher wrote this', 'Yoni', 'yoni@school.org', 0, '10-4', false, true, 1]);
  const db = new SheetStore(ss);
  assert.equal(db.get('students', 'yoni@school.org').voiceAnswers, true);
  db.insert('students', { id: 'new@school.org', name: 'New', className: '9-1' });
  assert.deepEqual(sh.cells[2], ['', 'New', 'new@school.org', '', '9-1', '', '', '']);
  assert.equal(db.get('students', 'new@school.org').readAloud, false);
  assert.equal(sh.cells[1][0], 'teacher wrote this');
});

test('new sheets, wide tables, big JSON, delete', () => {
  const ss = new FakeSpreadsheet();
  const db = new SheetStore(ss);
  const big = { text: 'x'.repeat(100000) };
  db.insert('attempts', { id: 'a', testId: 't', studentId: 's', status: 'in_progress', snapshot: big, answers: {}, grading: {} });
  db.insert('attempts', { id: 'b', testId: 't', studentId: 's2', status: 'submitted', snapshot: {}, answers: { q: 1 }, grading: {} });
  assert.equal(ss.getSheetByName('attempts').getMaxColumns() >= 28, true, 'sheet widened beyond the default 26 columns');
  assert.deepEqual(db.get('attempts', 'a').snapshot, big);
  assert.equal(db.all('attempts', true).length, 2);
  assert.equal(db.all('attempts', true)[0].snapshot, undefined, 'light reads skip JSON');
  db.update('attempts', 'b', { answers: { q: 2 } });
  assert.deepEqual(db.get('attempts', 'b').answers, { q: 2 });
  db.remove('attempts', 'a');
  assert.deepEqual(db.all('attempts').map((x) => x.id), ['b']);
  db.insert('events', { attemptId: 'b', at: 1, type: 'left', counted: true });
  db.insert('events', { attemptId: 'z', at: 2, type: 'left', counted: true });
  db.removeWhere('events', (e) => e.attemptId === 'b');
  assert.deepEqual(db.all('events').map((e) => e.attemptId), ['z']);
});

test('the upgrade, run on a sheet laid out like the previous version, keeps a graded attempt intact', () => {
  Object.assign(globalThis, require('../src/server/Core.js'));
  const { createApi, HttpError } = require('../src/server/Api.js');
  globalThis.HttpError = HttpError;
  const ss = new FakeSpreadsheet();
  const sample = require('../samples/past-simple-vs-past-progressive.json');
  const data = normalizeTest({ ...sample, classes: ['10-3'] });
  delete data.classIds; // the previous version didn't have it
  const testsSheet = ss.insertSheet('tests');
  testsSheet.cells.push(['id', 'ownerId', 'title', 'status', 'updatedAt', ...Array.from({ length: 8 }, (_, i) => `data#${i + 1}`)]);
  const dataText = JSON.stringify(data);
  testsSheet.cells.push(['t1', 'teacher@school.org', data.title, 'closed', 5, dataText, '', '', '', '', '', '', '']);
  oldSheet(ss, 'students', [['dana@school.org', 'Dana Levi', '10-3', true, true, 25], ['yoni@school.org', 'Yoni', '10-3', false, false, 0]]);
  const answers = { a1: 1, b1: 'went', d1: 'My brother was sleeping when the fire alarm went off.' };
  const grading = { d1: { points: 2, comment: 'Nice' } };
  oldSheet(ss, 'attempts', [['att1', 't1', 'dana@school.org', 'returned', 1000, 2000, 1500, 'student', 9, 100, 1600, 'tab', 1, 'Good work',
    JSON.stringify(answers), '', '', '', JSON.stringify(grading), '', dataText, '', '', '', '', '', '', '']]);
  const before = JSON.stringify(ss.getSheetByName('attempts').cells);

  const db = new SheetStore(ss);
  const api = createApi({ db, ownerEmail: 'teacher@school.org', withLock: (f) => f(), files: { read: () => '', save: () => '', remove: () => {} } });
  api.migrate();

  assert.equal(JSON.stringify(ss.getSheetByName('attempts').cells), before, 'attempts tab not changed at all');
  const teacher = { id: 'teacher@school.org', email: 'teacher@school.org', role: 'teacher', admin: true };
  const detail = api.handle('GET', '/api/attempts/att1', null, teacher);
  assert.deepEqual(detail.attempt.answers, answers);
  assert.deepEqual(detail.attempt.grading, grading);
  assert.equal(detail.attempt.feedback, 'Good work');
  const rows = api.handle('GET', '/api/tests/t1/attempts', null, teacher);
  assert.equal(rows.attempts[0].name, 'Dana Levi');
  assert.equal(rows.attempts[0].className, '10-3');
  assert.deepEqual(rows.notStarted.map((s) => s.name), ['Yoni']);
  const dana = { id: 'dana@school.org', email: 'dana@school.org', role: 'student', extraTimePct: 25 };
  const home = api.handle('GET', '/api/my/tests', null, dana);
  assert.equal(home.tests[0].attempt.status, 'returned');
  assert.equal(home.tests[0].attempt.score, 9);
  const result = api.handle('GET', '/api/my/attempts/att1/result', null, dana);
  assert.equal(result.marks.d1.comment, 'Nice');
});
