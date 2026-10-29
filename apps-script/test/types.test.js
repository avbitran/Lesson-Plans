'use strict';
// Fill in the blanks, matching, and natural-voice audio.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const core = require('../src/server/Core.js');
Object.assign(globalThis, core);
const { createApi, HttpError } = require('../src/server/Api.js');
globalThis.HttpError = HttpError;
const { MemoryStore } = require('./memory-store.js');

const TEST = {
  title: 'Vocabulary',
  language: 'en-US',
  timeLimitMin: 0,
  questions: [
    {
      id: 'b1',
      type: 'blanks',
      title: 'Complete the sentences.',
      wordBank: ['business', 'organization', 'charity'],
      prompt: "She opened a small {business}.\nShe works for a non-profit {organization} that operates as a children's {charity}.\nIt is fun {to play|playing} games.\nTranslate: Unique {}",
      points: 4,
    },
    {
      id: 'm1',
      type: 'match',
      prompt: 'Match the words to their definitions.',
      pairs: [
        { left: 'Unique', right: 'special' },
        { left: 'Repair', right: 'to fix' },
        { left: 'Career', right: 'a job' },
        { left: 'Volunteer', right: 'to work without pay' },
      ],
      extra: ['to sing'],
      points: 4,
    },
    { id: 'h1', type: 'long', prompt: 'אני רוצה לעשות שינוי בעולם.', modelAnswer: 'I want to make a change in the world.', points: 4 },
  ],
};

function setup({ tts } = {}) {
  const db = new MemoryStore();
  const drive = new Map();
  const calls = [];
  let saved = {};
  const api = createApi({
    db,
    ownerEmail: 'teacher@school.org',
    now: () => 1_700_000_000_000,
    withLock: (fn) => fn(),
    hash: (s) => crypto.createHash('sha256').update(s).digest('hex'),
    tts: tts === null ? undefined : {
      synthesize(o) {
        calls.push(o);
        if (tts) return tts(o);
        return ttsPieces(o.text, o.language, 120).map((p) => ({ mime: 'audio/mpeg', data: Buffer.from(`${p.lang}:${p.text}`).toString('base64') }));
      },
    },
    files: {
      save: (name, mime, data, kind) => (drive.set(name, { data, kind }), name),
      read: (id) => drive.get(id).data,
      remove: (id) => drive.delete(id),
    },
    exportResults: () => '',
    settings: { get: () => ({ voices: saved }), set: () => {}, setVoices: (v) => (saved = { ...saved, ...v }) },
  });
  const teacher = { id: 'teacher@school.org', email: 'teacher@school.org', role: 'teacher', admin: true };
  const call = (user, method, path, body) => {
    try {
      return { status: 200, body: api.handle(method, path, body, user) };
    } catch (e) {
      if (e instanceof core.ValidationError) return { status: 400, body: { error: e.message } };
      if (!e.status) throw e;
      return { status: e.status, body: { error: e.message } };
    }
  };
  const classId = call(teacher, 'POST', '/api/classes', { name: '9-1' }).body.id;
  call(teacher, 'POST', `/api/classes/${classId}/students`, { people: [{ email: 'dana@school.org', name: 'Dana' }] });
  const dana = { id: 'dana@school.org', email: 'dana@school.org', role: 'student', name: 'Dana', readAloud: true };
  return { db, drive, calls, call, teacher, dana, classId, saved: () => saved };
}

test('blanks and matching: validation', () => {
  const t = normalizeTest(TEST);
  assert.equal(parseBlanks(t.questions[0].prompt).length, 5);
  assert.deepEqual(parseBlanks(t.questions[0].prompt)[3], ['to play', 'playing']);
  assert.deepEqual(parseBlanks(t.questions[0].prompt)[4], [], 'empty braces = teacher marks');
  assert.throws(() => normalizeTest({ title: 'x', questions: [{ type: 'blanks', prompt: 'No braces here' }] }), /curly braces/);
  assert.throws(() => normalizeTest({ title: 'x', questions: [{ type: 'match', pairs: [{ left: 'a', right: 'b' }] }] }), /two pairs/);
  assert.equal(normalizeTest({ title: 'x', questions: [{ type: 'blanks', prompt: 'a {b}', dropdown: true }] }).questions[0].dropdown, false, 'no drop-down without a word bank');
});

test('students never see the answers, and matching choices are mixed but stable', () => {
  const view = studentView(normalizeTest(TEST));
  const [b, m, hq] = view.questions;
  assert.equal(b.prompt, "She opened a small {}.\nShe works for a non-profit {} that operates as a children's {}.\nIt is fun {} games.\nTranslate: Unique {}");
  assert.equal(b.blankCount, 5);
  assert.ok(!JSON.stringify(view).includes('to play'));
  assert.equal(m.pairs, undefined);
  assert.deepEqual(m.left, ['Unique', 'Repair', 'Career', 'Volunteer']);
  assert.deepEqual([...m.right].sort(), ['a job', 'special', 'to fix', 'to sing', 'to work without pay']);
  assert.notDeepEqual(m.right, ['special', 'to fix', 'a job', 'to work without pay', 'to sing'], 'not in answer order');
  assert.deepEqual(studentView(normalizeTest(TEST)).questions[1].right, m.right, 'same order every time');
  assert.match(b.speech, /The words are: business, organization, charity\./);
  assert.match(b.speech, /She opened a small … blank …\./);
  assert.match(m.speech, /1: Unique\.\n2: Repair\./);
  assert.match(m.speech, /The choices are:\nA: /);
  assert.equal(hq.speech, 'אני רוצה לעשות שינוי בעולם.');
});

test('blanks and matching: saving and marking', () => {
  const { call, teacher, dana, db, classId } = setup();
  const id = call(teacher, 'POST', '/api/tests', { data: { ...TEST, classIds: [classId] } }).body.id;
  call(teacher, 'PUT', `/api/tests/${id}`, { status: 'open' });
  const start = call(dana, 'POST', `/api/my/tests/${id}/start`, { clientId: 'c' }).body;
  const attemptId = start.attempt.id;
  const right = start.test.questions[1].right;
  const answers = {
    b1: ['Business.', 'charity', 'charity', 'PLAYING', 'ייחודי', 'extra ignored'],
    m1: ['special', 'to fix', 'to sing', 'not a choice'],
    h1: 'I want to make a change in the world.',
  };
  call(dana, 'PUT', `/api/my/attempts/${attemptId}/answers`, { clientId: 'c', answers });
  const stored = db.get('attempts', attemptId).answers;
  assert.deepEqual(stored.b1, ['Business.', 'charity', 'charity', 'PLAYING', 'ייחודי'], 'one answer per blank');
  assert.deepEqual(stored.m1, ['special', 'to fix', 'to sing', ''], 'only real choices are kept');
  assert.ok(right.includes('to sing'));

  call(dana, 'PUT', `/api/my/attempts/${attemptId}/answers`, { clientId: 'c', answers: { ...answers, m1: ['', '', '', ''] } });
  assert.equal(db.get('attempts', attemptId).answers.m1, undefined, 'all-empty answers are dropped');

  call(dana, 'POST', `/api/my/attempts/${attemptId}/submit`, { clientId: 'c', answers });
  const auto = call(teacher, 'GET', `/api/attempts/${attemptId}`).body.auto;
  // Blanks: 3 of 5 right (business, charity, playing) -> 4 * 3/5; the wrong
  // "charity" and the Hebrew translation need the teacher.
  assert.equal(auto.b1.auto, 2.4);
  assert.equal(auto.b1.review, true);
  // Matching: 2 of 4 -> 4 * 2/4.
  assert.equal(auto.m1.auto, 2);
  assert.equal(auto.m1.review, false);
  assert.equal(auto.h1.auto, null);
});

test('natural voices: prepare audio, students get it, device voice otherwise', () => {
  const { call, teacher, dana, calls, drive, classId } = setup();
  const data = { ...TEST, classIds: [classId], settings: { readAloudForAll: true, voice: { provider: 'google', name: 'en-US-Neural2-F' } } };
  const id = call(teacher, 'POST', '/api/tests', { data }).body.id;
  call(teacher, 'PUT', `/api/tests/${id}`, { status: 'open' });

  let st = call(teacher, 'GET', `/api/tests/${id}/audio`).body;
  assert.deepEqual(st, { provider: 'google', total: 3, ready: 0, missing: 3 });
  const preview = call(teacher, 'GET', `/api/tests/${id}/preview`).body.test;
  assert.ok(preview.questions.every((q) => q.audio === null), 'nothing prepared yet: device voice');

  st = call(teacher, 'POST', `/api/tests/${id}/audio`).body;
  assert.equal(st.missing, 0);
  assert.equal(st.made, 3);
  assert.equal(calls[0].voice, 'en-US-Neural2-F');
  assert.ok([...drive.values()].every((f) => f.kind === 'audio'), 'audio goes to its own folder');
  assert.equal(call(teacher, 'POST', `/api/tests/${id}/audio`).body.made, 0, 'nothing made twice');

  const q = call(dana, 'POST', `/api/my/tests/${id}/start`, { clientId: 'c' }).body.test.questions[2];
  assert.ok(q.audio, 'students get the prepared audio');
  const first = call(dana, 'GET', `/api/audio/${q.audio}/0`).body;
  assert.equal(first.mime, 'audio/mpeg');
  assert.equal(Buffer.from(first.data, 'base64').toString(), 'he-IL:אני רוצה לעשות שינוי בעולם.', 'Hebrew text gets a Hebrew voice');
  assert.equal(call(dana, 'GET', `/api/audio/${q.audio}/9`).status, 404);
  assert.equal(call(dana, 'POST', `/api/tests/${id}/audio`).status, 403, 'only teachers prepare audio');

  // Changing the text means new audio; until then that item uses the device voice.
  data.questions = data.questions.map((x) => (x.id === 'h1' ? { ...x, prompt: 'Translate: אני אוהב ספרים.' } : x));
  call(teacher, 'PUT', `/api/tests/${id}`, { data });
  assert.equal(call(teacher, 'GET', `/api/tests/${id}/audio`).body.missing, 1);
  assert.equal(call(teacher, 'GET', `/api/tests/${id}/preview`).body.test.questions.find((x) => x.id === 'h1').audio, null);

  // Device voice: nothing to prepare.
  data.settings.voice = { provider: 'browser', name: '' };
  call(teacher, 'PUT', `/api/tests/${id}`, { data });
  assert.equal(call(teacher, 'GET', `/api/tests/${id}/audio`).body.total, 0);
  assert.equal(call(teacher, 'POST', `/api/tests/${id}/audio`).status, 400);
});

test('natural voices: errors from the voice service reach the teacher', () => {
  const { call, teacher } = setup({
    tts: () => {
      throw new HttpError(400, 'Add your Google Cloud key first.');
    },
  });
  const id = call(teacher, 'POST', '/api/tests', { data: { ...TEST, settings: { voice: { provider: 'google' } } } }).body.id;
  const r = call(teacher, 'POST', `/api/tests/${id}/audio`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Google Cloud key/);
  assert.equal(call(teacher, 'POST', '/api/voices/try', { provider: 'browser' }).status, 400);
});

test('voice settings: keys stay on the server, private addresses are refused', () => {
  const { call, teacher, dana, saved } = setup();
  assert.equal(call(teacher, 'PUT', '/api/settings/voices', { chatterboxUrl: 'http://localhost:4123' }).status, 400);
  assert.equal(call(teacher, 'PUT', '/api/settings/voices', { chatterboxUrl: 'http://192.168.1.5:4123' }).status, 400);
  assert.equal(call(teacher, 'PUT', '/api/settings/voices', { chatterboxUrl: 'ftp://x' }).status, 400);
  assert.equal(call(teacher, 'PUT', '/api/settings/voices', { googleKey: 'AIza123', chatterboxUrl: 'https://abc.trycloudflare.com/' }).status, 200);
  assert.deepEqual(saved(), { googleKey: 'AIza123', chatterboxUrl: 'https://abc.trycloudflare.com', chatterboxKey: undefined });
  assert.equal(call(dana, 'PUT', '/api/settings/voices', { googleKey: 'x' }).status, 403);
});

test('ttsPieces splits by language and length', () => {
  const p = ttsPieces('Read the text. אני רוצה לעשות שינוי בעולם. Then answer.', 'en-US', 300);
  assert.deepEqual(p.map((x) => x.lang), ['en-US', 'he-IL', 'en-US']);
  const long = ttsPieces('word '.repeat(200), 'en-US', 100);
  assert.ok(long.every((x) => x.text.length <= 100));
  assert.equal(long.map((x) => x.text).join(' ').split(' ').length, 200);
});
