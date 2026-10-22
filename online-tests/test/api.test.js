'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'online-tests-'));
process.env.SETUP_CODE = '123456';
const { server, refreshSetupCode } = require('../server');
const sample = require('../samples/past-simple-vs-past-progressive.json');

let base;
before(async () => {
  refreshSetupCode();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const isBlob = body instanceof Buffer;
    const res = await fetch(base + url, {
      method,
      headers: {
        'X-Requested-With': 'fetch',
        ...(body !== undefined && !isBlob ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
}

test('full flow: setup, students, test, attempt, events, recording, grading, results', async () => {
  const teacher = client();
  assert.equal((await teacher('POST', '/api/setup', { code: 'wrong', name: 'T', username: 'teach', password: 'password1' })).status, 403);
  const setup = await teacher('POST', '/api/setup', { code: '123456', name: 'Ms. T', username: 'teach', password: 'password1' });
  assert.equal(setup.status, 200);
  assert.equal((await teacher('POST', '/api/setup', { code: '123456', name: 'X', username: 'x2', password: 'password1' })).status, 409);

  // CSRF header is required
  const noHeader = await fetch(base + '/api/tests', { method: 'POST', body: '{}' });
  assert.equal(noHeader.status, 403);

  const created = await teacher('POST', '/api/users/bulk', { people: [{ name: 'Dana Levi', className: '10-3' }, { name: 'Yoni', className: '10-4' }] });
  assert.equal(created.body.created.length, 2);
  const [dana, yoni] = created.body.created;
  assert.equal(dana.username, 'dana.levi');
  await teacher('PUT', `/api/users/${dana.id}`, { voiceAnswers: true, readAloud: true, extraTimePct: 25 });

  const t = await teacher('POST', '/api/tests', { data: { ...sample, classes: ['10-3'] } });
  assert.equal(t.status, 200);
  const testId = t.body.id;

  const student = client();
  assert.equal((await student('POST', '/api/login', { username: dana.username, password: 'nope' })).status, 401);
  assert.equal((await student('POST', '/api/login', { username: dana.username, password: dana.password })).status, 200);
  assert.equal((await student('GET', '/api/tests')).status, 403, 'students cannot reach teacher API');

  // Draft is invisible
  assert.equal((await student('GET', '/api/my/tests')).body.tests.length, 0);
  await teacher('PUT', `/api/tests/${testId}`, { status: 'open' });
  assert.equal((await student('GET', '/api/my/tests')).body.tests.length, 1);

  // Other class can't see it
  const other = client();
  await other('POST', '/api/login', { username: yoni.username, password: yoni.password });
  assert.equal((await other('GET', '/api/my/tests')).body.tests.length, 0);
  assert.equal((await other('POST', `/api/my/tests/${testId}/start`, { clientId: 'x' })).status, 403);

  const rules = await student('GET', `/api/my/tests/${testId}/rules`);
  assert.equal(rules.body.accommodations.voiceAnswers, true);

  const start = await student('POST', `/api/my/tests/${testId}/start`, { clientId: 'tab1' });
  assert.equal(start.status, 200);
  const attemptId = start.body.attempt.id;
  const deadline = start.body.attempt.deadlineAt - start.body.attempt.startedAt;
  assert.equal(Math.round(deadline / 60000), Math.round(25 * 1.25), 'extra time applied');
  assert.ok(start.body.test.questions.every((q) => q.correct === undefined && q.accepted === undefined), 'no answer key sent');

  const answers = { a1: 1, a2: 1, b1: 'Went.', b3: 'was rained', c4: 'Correct', d1: 'My brother was sleeping when the alarm went off.' };
  assert.equal((await student('PUT', `/api/my/attempts/${attemptId}/answers`, { clientId: 'tab1', answers })).status, 200);

  // A second tab takes over; the first is rejected
  await student('POST', `/api/my/tests/${testId}/start`, { clientId: 'tab2' });
  assert.equal((await student('PUT', `/api/my/attempts/${attemptId}/answers`, { clientId: 'tab1', answers })).status, 409);

  const rec = await student('POST', `/api/my/attempts/${attemptId}/recordings?q=d2&duration=4.2&clientId=tab2`, Buffer.alloc(2000, 1), { 'Content-Type': 'audio/webm;codecs=opus' });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal((await other('GET', `/api/recordings/${rec.body.id}`)).status, 404, 'other students cannot hear it');
  const audio = await fetch(`${base}/api/recordings/${rec.body.id}`, { headers: { Cookie: '' } });
  assert.equal(audio.status, 401);

  // Leaving the test: 3 strikes -> locked
  for (let i = 0; i < 2; i++) {
    const e = await student('POST', `/api/my/attempts/${attemptId}/events`, { clientId: 'tab2', type: 'left', detail: 'tab' });
    assert.equal(e.body.status, 'in_progress');
  }
  await student('POST', `/api/my/attempts/${attemptId}/events`, { clientId: 'tab2', type: 'paste_blocked' });
  const third = await student('POST', `/api/my/attempts/${attemptId}/events`, { clientId: 'tab2', type: 'fullscreen_exit' });
  assert.equal(third.body.status, 'locked');
  assert.equal(third.body.violations, 3);
  assert.equal((await student('PUT', `/api/my/attempts/${attemptId}/answers`, { clientId: 'tab2', answers })).status, 423);

  const list = await teacher('GET', `/api/tests/${testId}/attempts`);
  assert.equal(list.body.attempts[0].status, 'locked');
  assert.equal(list.body.notStarted.length, 0);
  await teacher('POST', `/api/attempts/${attemptId}/unlock`, { addMinutes: 5 });

  const submit = await student('POST', `/api/my/attempts/${attemptId}/submit`, { clientId: 'tab2', answers });
  assert.equal(submit.body.status, 'submitted');
  assert.equal((await student('POST', `/api/my/tests/${testId}/start`, { clientId: 'tab3' })).status, 409);

  const detail = await teacher('GET', `/api/attempts/${attemptId}`);
  const auto = detail.body.auto;
  assert.equal(auto.a1.auto, 4);
  assert.equal(auto.a2.auto, 0);
  assert.equal(auto.b1.auto, 3, 'case and full stop ignored');
  assert.equal(auto.b3.auto, 0);
  assert.equal(auto.b3.review, true, 'non-matching short answer flagged');
  assert.equal(auto.c4.auto, 4);
  assert.equal(auto.d1.auto, null);
  assert.equal(auto.d2.auto, null, 'voice answer needs teacher');
  assert.equal(auto.a3.auto, 0);
  assert.equal(auto.a3.review, false);
  assert.equal(detail.body.attempt.score, 11);
  assert.ok(detail.body.events.some((e) => e.type === 'reopened'));

  // Results hidden until returned
  assert.equal((await student('GET', `/api/my/attempts/${attemptId}/result`)).status, 403);
  const graded = await teacher('PUT', `/api/attempts/${attemptId}/grade`, {
    grading: { d1: { points: 2, comment: 'Nice' }, d2: { points: 1.5 }, b3: { points: 99 } },
    feedback: 'Good work',
    returnToStudent: true,
  });
  assert.equal(graded.body.score, 11 + 2 + 1.5 + 3, 'teacher marks clamp to max');
  const result = await student('GET', `/api/my/attempts/${attemptId}/result`);
  assert.equal(result.status, 200);
  assert.equal(result.body.marks.d1.comment, 'Nice');
  assert.equal(result.body.feedback, 'Good work');

  const csv = await teacher('GET', `/api/tests/${testId}/export.csv`);
  assert.match(csv.body, /Dana Levi,dana\.levi,10-3,returned,17\.5,100/);

  // Retake: deleting the attempt removes the recording file
  const recDir = path.join(process.env.DATA_DIR, 'recordings');
  assert.equal(fs.readdirSync(recDir).length, 1);
  await teacher('DELETE', `/api/attempts/${attemptId}`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readdirSync(recDir).length, 0);
});

test('static files cannot escape the public folder', async () => {
  const res = await fetch(`${base}/..%2fserver.js`);
  assert.equal(res.status, 404);
  const ok = await fetch(`${base}/take`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-security-policy'), /default-src 'self'/);
});

test('wrong passwords lock only that username', async () => {
  const c = client();
  for (let i = 0; i < 10; i++) await c('POST', '/api/login', { username: 'nobody', password: 'x' });
  assert.equal((await c('POST', '/api/login', { username: 'nobody', password: 'x' })).status, 429);
  assert.equal((await c('POST', '/api/login', { username: 'teach', password: 'password1' })).status, 200);
});
