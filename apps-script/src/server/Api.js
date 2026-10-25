// Every request from the pages goes through handle(method, path, body, user).
// Storage, Drive and locking are passed in, so the same code runs in Apps
// Script (Sheets + Drive) and in the Node tests (in-memory fakes).

const DEADLINE_GRACE_MS = 30e3; // network slack for the last autosave
const MAX_EVENTS_PER_ATTEMPT = 1000;
const MAX_AUDIO_BASE64 = 14 * 1024 * 1024; // about 10 MB of audio
const AUDIO_BUDGET_MS = 40e3; // natural-voice audio made per request, then the page asks again
const COUNTED_EVENTS = ['left', 'fullscreen_exit'];
const LOGGED_EVENTS = ['returned', 'paste_blocked', 'copy_blocked', 'shortcut_blocked', 'fullscreen_refused', 'recorder_opened'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createApi(env) {
  const { db, files, withLock, exportResults } = env;
  const clock = env.clock || (() => Date.now()); // real time, for work budgets
  const now = env.now || (() => Date.now());
  const routes = [];
  const route = (method, pattern, role, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, role, handler });
  };

  // ------------------------------------------------------------- helpers

  const ownerEmail = () => env.ownerEmail;

  function getTest(id) {
    const t = db.get('tests', String(id));
    if (!t) throw new HttpError(404, 'Test not found.');
    return t;
  }

  function getAttempt(id) {
    const a = db.get('attempts', String(id));
    if (!a) throw new HttpError(404, 'Attempt not found.');
    a.answers = a.answers || {};
    a.grading = a.grading || {};
    return a;
  }

  function ownAttempt(id, user) {
    const a = getAttempt(id);
    if (a.studentId !== user.id) throw new HttpError(404, 'Attempt not found.');
    return a;
  }

  const recordingsOf = (attemptId) => db.all('recordings').filter((r) => r.attemptId === attemptId);
  const recordedIds = (attemptId) => new Set(recordingsOf(attemptId).map((r) => r.questionId));

  function logEvent(attemptId, type, detail, counted) {
    db.insert('events', { attemptId, at: now(), type, detail: String(detail || '').slice(0, 300), counted: !!counted });
  }

  function submitAttempt(a, reason) {
    const auto = autoGrade(a.snapshot, a.answers, recordedIds(a.id));
    db.update('attempts', a.id, {
      status: 'submitted',
      submittedAt: now(),
      submitReason: reason,
      score: totalScore(a.snapshot, auto, a.grading),
      maxScore: maxScore(a.snapshot),
    });
    a.status = 'submitted';
    logEvent(a.id, 'submitted', reason, false);
  }

  // Attempts whose time ran out while the student was away get submitted
  // with whatever was autosaved.
  function sweepExpired(attempts) {
    for (const a of attempts || db.all('attempts', true)) {
      if ((a.status === 'in_progress' || a.status === 'locked') && a.deadlineAt && a.deadlineAt + DEADLINE_GRACE_MS < now()) {
        submitAttempt(getAttempt(a.id), 'time');
      }
    }
  }

  function removeRecordings(list) {
    for (const r of list) {
      files.remove(r.fileId);
      db.remove('recordings', r.id);
    }
  }

  function removeAttempt(a) {
    removeRecordings(recordingsOf(a.id));
    db.removeWhere('events', (e) => e.attemptId === a.id);
    db.remove('attempts', a.id);
  }

  // ------------------------------------------------- natural-voice audio
  // Audio is made once per piece of text and voice, stored in Drive, and
  // shared by every test that reads the same text with the same voice.

  const voiceOf = (test) => (test.settings && test.settings.voice) || { provider: 'browser', name: '' };
  const naturalVoice = (test) => voiceOf(test).provider !== 'browser' && !!env.tts;
  const clipId = (voice, lang, text) => env.hash(`${voice.provider}|${voice.name}|${lang}|${text}`).slice(0, 24);

  let audioIds = null;
  const audioReady = (id) => (audioIds ||= new Set(db.all('audio', true).map((x) => x.id))).has(id);

  // studentView's audio lookup for one test.
  const audioFor = (test) => {
    if (!naturalVoice(test)) return null;
    const v = voiceOf(test);
    return (text) => {
      const id = clipId(v, test.language, text);
      return audioReady(id) ? id : null;
    };
  };
  const viewOf = (test) => studentView(test, audioFor(test));

  // Every piece of text a test reads aloud.
  const speechList = (test) => {
    const view = studentView(test);
    return [view.instructionsSpeech].concat(view.questions.map((q) => q.speech)).filter(Boolean);
  };

  function audioStatus(test) {
    const v = voiceOf(test);
    if (!naturalVoice(test)) return { provider: v.provider, total: 0, ready: 0, missing: 0 };
    const texts = [...new Set(speechList(test))];
    const ready = texts.filter((t) => audioReady(clipId(v, test.language, t))).length;
    return { provider: v.provider, total: texts.length, ready, missing: texts.length - ready };
  }

  function makeClip(test, text) {
    const v = voiceOf(test);
    const id = clipId(v, test.language, text);
    const pieces = env.tts.synthesize({ provider: v.provider, voice: v.name, language: test.language, text });
    const parts = pieces.map((p, i) => ({ fileId: files.save(`read-aloud ${id} ${i + 1}.${p.mime.includes('wav') ? 'wav' : 'mp3'}`, p.mime, p.data, 'audio'), mime: p.mime }));
    db.insert('audio', { id, provider: v.provider, voice: v.name, chars: text.length, createdAt: now(), parts });
    audioIds && audioIds.add(id);
  }

  const canRecord = (user, test) => !!user.voiceAnswers || test.settings.recordingForAll;
  const sameClass = (test, className) => {
    const classes = test.classes.map((c) => c.toLowerCase());
    return classes.length === 0 || classes.includes(String(className || '').toLowerCase());
  };
  const testVisibleTo = (t, user) => t.status === 'open' && sameClass(t.data, user.className);

  function sanitizeAnswers(test, input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const q of test.questions) {
      if (q.type === 'section' || !(q.id in input)) continue;
      const v = input[q.id];
      const validOption = (x) => Number.isInteger(x) && x >= 0 && x < q.options.length;
      if (q.type === 'mc' && q.multiple) {
        const picks = Array.isArray(v) ? [...new Set(v.filter(validOption))] : [];
        if (picks.length && picks.length <= q.correct.length) out[q.id] = picks;
      } else if (q.type === 'mc') {
        if (validOption(v)) out[q.id] = v;
      } else if (q.type === 'blanks' || q.type === 'match') {
        // One string per blank / per item to match. Matching answers must be
        // one of the choices.
        const n = q.type === 'blanks' ? parseBlanks(q.prompt).length : q.pairs.length;
        const choices = q.type === 'match' ? new Set(matchChoices(q)) : null;
        const list = (Array.isArray(v) ? v : []).slice(0, n).map((x) => {
          const t = typeof x === 'string' ? x.slice(0, 500) : '';
          return choices && !choices.has(t) ? '' : t;
        });
        if (list.some((x) => x.trim())) out[q.id] = list;
      } else if (typeof v === 'string') {
        out[q.id] = v.slice(0, 20000);
      }
    }
    return out;
  }

  function studentAttemptPayload(a, user) {
    const test = a.snapshot;
    return {
      attempt: {
        id: a.id,
        status: a.status,
        startedAt: a.startedAt,
        deadlineAt: a.deadlineAt,
        serverNow: now(),
        answers: a.answers,
        violations: a.violations || 0,
      },
      test: viewOf(test),
      recordings: recordingsOf(a.id).map((r) => ({ id: r.id, questionId: r.questionId, duration: r.duration })),
      accommodations: {
        readAloud: !!user.readAloud || test.settings.readAloudForAll,
        voiceAnswers: canRecord(user, test),
      },
    };
  }

  // Guards every write a student makes during a test.
  function assertWritable(a, clientId) {
    if (a.status === 'locked') throw new HttpError(423, 'Your test is paused. Ask your teacher to unlock it.');
    if (a.status !== 'in_progress') throw new HttpError(409, 'This test has already been submitted.');
    if (a.clientId && clientId !== a.clientId)
      throw new HttpError(409, 'This test was opened in another window or device. Only the newest one can continue.');
    if (a.deadlineAt && now() > a.deadlineAt + DEADLINE_GRACE_MS) {
      submitAttempt(a, 'time');
      throw new HttpError(409, 'Time is up. Your test was submitted with your saved answers.');
    }
  }

  const cleanEmail = (s) => String(s || '').trim().toLowerCase();
  const isEmail = (s) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s);

  function publicStudent(s) {
    return {
      id: s.id,
      email: s.id,
      name: s.name,
      className: s.className || '',
      readAloud: !!s.readAloud,
      voiceAnswers: !!s.voiceAnswers,
      extraTimePct: s.extraTimePct || 0,
    };
  }

  // ---------------------------------------------------------------- me

  route('GET', '/api/me', null, (ctx) => ({ user: ctx.user }));

  // ------------------------------------------------------ teacher: people

  route('GET', '/api/users', 'teacher', () => ({
    students: db
      .all('students')
      .map(publicStudent)
      .sort((a, b) => (a.className + a.name).localeCompare(b.className + b.name)),
    teachers: [{ id: ownerEmail(), email: ownerEmail(), owner: true }].concat(
      db.all('teachers').filter((t) => t.id !== ownerEmail()).map((t) => ({ id: t.id, email: t.id, owner: false })),
    ),
  }));

  route('POST', '/api/students/bulk', 'teacher', ({ body }) => {
    const people = Array.isArray(body.people) ? body.people.slice(0, 500) : [];
    const added = [];
    const skipped = [];
    for (const p of people) {
      const email = cleanEmail(p.email);
      if (!isEmail(email)) {
        skipped.push(`${p.email || '(empty)'}: not an email address`);
        continue;
      }
      const fields = {
        name: String(p.name || '').trim().slice(0, 100) || email.split('@')[0],
        className: String(p.className || '').trim().slice(0, 60),
      };
      if (db.get('students', email)) db.update('students', email, fields);
      else db.insert('students', { id: email, readAloud: false, voiceAnswers: false, extraTimePct: 0, ...fields });
      added.push(email);
    }
    return { added: added.length, skipped };
  });

  route('PUT', '/api/students/:id', 'teacher', ({ params, body }) => {
    const s = db.get('students', params.id);
    if (!s) throw new HttpError(404, 'Student not found.');
    const patch = {};
    if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 100) || s.name;
    if (body.className !== undefined) patch.className = String(body.className).trim().slice(0, 60);
    if (body.readAloud !== undefined) patch.readAloud = !!body.readAloud;
    if (body.voiceAnswers !== undefined) patch.voiceAnswers = !!body.voiceAnswers;
    if (body.extraTimePct !== undefined) patch.extraTimePct = Math.min(200, Math.max(0, parseInt(body.extraTimePct, 10) || 0));
    db.update('students', s.id, patch);
    return { student: publicStudent(db.get('students', s.id)) };
  });

  route('DELETE', '/api/students/:id', 'teacher', ({ params }) => {
    for (const a of db.all('attempts', true).filter((x) => x.studentId === params.id)) removeAttempt(a);
    db.remove('students', params.id);
    return { ok: true };
  });

  route('POST', '/api/teachers', 'teacher', ({ body }) => {
    const email = cleanEmail(body.email);
    if (!isEmail(email)) throw new HttpError(400, 'Enter an email address.');
    if (email !== ownerEmail() && !db.get('teachers', email)) db.insert('teachers', { id: email });
    return { ok: true };
  });

  route('DELETE', '/api/teachers/:id', 'teacher', ({ params }) => {
    if (params.id === ownerEmail()) throw new HttpError(400, 'The owner of the app is always a teacher.');
    db.remove('teachers', params.id);
    return { ok: true };
  });

  // ------------------------------------------------------- teacher: tests

  route('GET', '/api/tests', 'teacher', () => {
    sweepExpired(db.all('attempts', true));
    const fresh = db.all('attempts', true);
    return {
      tests: db
        .all('tests')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((t) => {
          const mine = fresh.filter((a) => a.testId === t.id);
          return {
            id: t.id,
            title: t.title,
            status: t.status,
            updatedAt: t.updatedAt,
            classes: t.data.classes,
            questionCount: t.data.questions.filter((q) => q.type !== 'section').length,
            active: mine.filter((a) => a.status === 'in_progress' || a.status === 'locked').length,
            toGrade: mine.filter((a) => a.status === 'submitted').length,
            returned: mine.filter((a) => a.status === 'returned').length,
          };
        }),
    };
  });

  route('POST', '/api/tests', 'teacher', ({ body, user }) => {
    const data = normalizeTest(body.data);
    const t = db.insert('tests', { ownerId: user.id, title: data.title, status: 'draft', data, updatedAt: now() });
    return { id: t.id };
  });

  route('GET', '/api/tests/:id', 'teacher', ({ params }) => {
    const t = getTest(params.id);
    return { id: t.id, status: t.status, data: t.data };
  });

  route('PUT', '/api/tests/:id', 'teacher', ({ params, body }) => {
    const t = getTest(params.id);
    const data = body.data !== undefined ? normalizeTest(body.data) : t.data;
    const status = ['draft', 'open', 'closed'].includes(body.status) ? body.status : t.status;
    db.update('tests', t.id, { title: data.title, status, data, updatedAt: now() });
    return { id: t.id, status, data };
  });

  route('POST', '/api/tests/:id/duplicate', 'teacher', ({ params, user }) => {
    const t = getTest(params.id);
    const data = Object.assign({}, t.data, { title: `${t.data.title} (copy)`.slice(0, 200) });
    const copy = db.insert('tests', { ownerId: user.id, title: data.title, status: 'draft', data, updatedAt: now() });
    return { id: copy.id };
  });

  route('DELETE', '/api/tests/:id', 'teacher', ({ params }) => {
    const t = getTest(params.id);
    for (const a of db.all('attempts', true).filter((x) => x.testId === t.id)) removeAttempt(a);
    db.remove('tests', t.id);
    return { ok: true };
  });

  route('GET', '/api/tests/:id/preview', 'teacher', ({ params }) => ({ test: viewOf(getTest(params.id).data) }));

  route('GET', '/api/tests/:id/audio', 'teacher', ({ params }) => audioStatus(getTest(params.id).data));

  // Makes missing natural-voice audio for a test, for up to ~40 seconds per
  // call; the page keeps calling until nothing is missing.
  route('POST', '/api/tests/:id/audio', 'teacher', ({ params }) => {
    const test = getTest(params.id).data;
    if (!naturalVoice(test)) throw new HttpError(400, 'This test uses the device voice, so there is no audio to prepare.');
    const v = voiceOf(test);
    const started = clock();
    let made = 0;
    for (const text of [...new Set(speechList(test))]) {
      if (audioReady(clipId(v, test.language, text))) continue;
      if (made > 0 && clock() - started > AUDIO_BUDGET_MS) break;
      makeClip(test, text);
      made++;
    }
    return Object.assign(audioStatus(test), { made });
  });

  // ▶ Try voice in the test editor: a short sample, not stored.
  route('POST', '/api/voices/try', 'teacher', ({ body }) => {
    if (!env.tts) throw new HttpError(400, 'Natural voices are not available here.');
    const provider = VOICE_PROVIDERS.includes(body.provider) && body.provider !== 'browser' ? body.provider : null;
    if (!provider) throw new HttpError(400, 'Choose Google or Chatterbox to try a natural voice.');
    const text = String(body.text || '').trim().slice(0, 300) || 'Hello! This is how I will read your test to your students.';
    const language = LANGUAGES.includes(body.language) ? body.language : 'en-US';
    const pieces = env.tts.synthesize({ provider, voice: String(body.name || '').slice(0, 100), language, text });
    return pieces[0];
  });

  route('GET', '/api/audio/:id/:n', 'any', ({ params }) => {
    const clip = db.get('audio', params.id);
    const part = clip && clip.parts && clip.parts[Number(params.n)];
    if (!part) throw new HttpError(404, 'Audio not found.');
    return { mime: part.mime, data: files.read(part.fileId), count: clip.parts.length };
  });

  function attemptRows(testId) {
    sweepExpired(db.all('attempts', true).filter((a) => a.testId === testId));
    const students = new Map(db.all('students').map((s) => [s.id, s]));
    const recs = db.all('recordings');
    return db
      .all('attempts')
      .filter((a) => a.testId === testId)
      .map((a) => {
        const s = students.get(a.studentId) || { name: a.studentId, className: '' };
        const answers = a.answers || {};
        const grading = a.grading || {};
        const recorded = new Set(recs.filter((r) => r.attemptId === a.id).map((r) => r.questionId));
        const auto = autoGrade(a.snapshot, answers, recorded);
        const toReview = Object.keys(auto).filter((qid) => auto[qid].review && !Number.isFinite(grading[qid] && grading[qid].points)).length;
        return {
          id: a.id,
          studentId: a.studentId,
          name: s.name,
          email: a.studentId,
          className: s.className || '',
          status: a.status,
          startedAt: a.startedAt,
          deadlineAt: a.deadlineAt,
          submittedAt: a.submittedAt,
          submitReason: a.submitReason,
          score: a.score,
          maxScore: a.maxScore != null ? a.maxScore : maxScore(a.snapshot),
          violations: a.violations || 0,
          toReview,
          answered: Object.keys(answers).length + [...recorded].filter((q) => !(q in answers)).length,
          questionCount: a.snapshot.questions.filter((q) => q.type !== 'section').length,
        };
      })
      .sort((x, y) => (x.className + x.name).localeCompare(y.className + y.name));
  }

  route('GET', '/api/tests/:id/attempts', 'teacher', ({ params }) => {
    const t = getTest(params.id);
    const attempts = attemptRows(t.id);
    const started = new Set(attempts.map((a) => a.studentId));
    const notStarted = db
      .all('students')
      .filter((s) => !started.has(s.id) && sameClass(t.data, s.className))
      .sort((a, b) => (a.className + a.name).localeCompare(b.className + b.name))
      .map((s) => ({ id: s.id, name: s.name, className: s.className }));
    return { test: { id: t.id, title: t.title, status: t.status, data: t.data }, attempts, notStarted };
  });

  route('POST', '/api/tests/:id/export', 'teacher', ({ params }) => {
    const t = getTest(params.id);
    const iso = (ms) => (ms ? (env.formatTime ? env.formatTime(ms) : new Date(ms).toISOString().replace('T', ' ').slice(0, 16)) : '');
    const rows = [['Name', 'Email', 'Class', 'Status', 'Score', 'Max', 'Started', 'Submitted', 'Times left the test']];
    for (const a of attemptRows(t.id))
      rows.push([a.name, a.email, a.className, a.status, a.score != null ? a.score : '', a.maxScore, iso(a.startedAt), iso(a.submittedAt), a.violations]);
    return { url: exportResults(t.title, rows) };
  });

  // ---------------------------------------------------- teacher: attempts

  route('GET', '/api/attempts/:id', 'teacher', ({ params }) => {
    const a = getAttempt(params.id);
    const s = db.get('students', a.studentId) || { id: a.studentId, name: a.studentId };
    return {
      attempt: {
        id: a.id,
        testId: a.testId,
        status: a.status,
        startedAt: a.startedAt,
        deadlineAt: a.deadlineAt,
        submittedAt: a.submittedAt,
        submitReason: a.submitReason,
        returnedAt: a.returnedAt,
        answers: a.answers,
        grading: a.grading,
        feedback: a.feedback || '',
        score: a.score,
        maxScore: maxScore(a.snapshot),
      },
      test: a.snapshot,
      auto: autoGrade(a.snapshot, a.answers, recordedIds(a.id)),
      student: publicStudent(s),
      events: db
        .all('events')
        .filter((e) => e.attemptId === a.id)
        .sort((x, y) => x.at - y.at)
        .map((e) => ({ at: e.at, type: e.type, detail: e.detail, counted: !!e.counted })),
      recordings: recordingsOf(a.id).map((r) => ({ id: r.id, questionId: r.questionId, duration: r.duration, createdAt: r.createdAt })),
    };
  });

  route('PUT', '/api/attempts/:id/grade', 'teacher', ({ params, body }) => {
    const a = getAttempt(params.id);
    if (a.status !== 'submitted' && a.status !== 'returned') throw new HttpError(409, 'The student has not submitted yet.');
    const grading = {};
    for (const q of a.snapshot.questions) {
      if (q.type === 'section') continue;
      const g = body.grading && body.grading[q.id];
      if (!g) continue;
      const pts = g.points === null || g.points === '' || g.points === undefined ? null : Number(g.points);
      grading[q.id] = {
        points: Number.isFinite(pts) ? Math.min(q.points, Math.max(0, pts)) : null,
        comment: String(g.comment || '').slice(0, 2000),
      };
    }
    const score = totalScore(a.snapshot, autoGrade(a.snapshot, a.answers, recordedIds(a.id)), grading);
    const ret = !!body.returnToStudent;
    db.update('attempts', a.id, {
      grading,
      feedback: String(body.feedback || '').slice(0, 5000),
      score,
      status: ret ? 'returned' : 'submitted',
      returnedAt: ret ? now() : null,
    });
    return { score, status: ret ? 'returned' : 'submitted' };
  });

  route('POST', '/api/attempts/:id/unlock', 'teacher', ({ params, body }) => {
    const a = getAttempt(params.id);
    if (a.status !== 'locked' && a.status !== 'in_progress') throw new HttpError(409, 'This test is already submitted.');
    const add = Math.min(240, Math.max(0, parseInt(body.addMinutes, 10) || 0));
    const deadline = a.deadlineAt ? Math.max(a.deadlineAt, now()) + add * 60e3 : null;
    db.update('attempts', a.id, { status: 'in_progress', deadlineAt: deadline });
    logEvent(a.id, 'unlocked', add ? `+${add} min` : '', false);
    return { ok: true };
  });

  route('POST', '/api/attempts/:id/force-submit', 'teacher', ({ params }) => {
    const a = getAttempt(params.id);
    if (a.status !== 'locked' && a.status !== 'in_progress') throw new HttpError(409, 'This test is already submitted.');
    submitAttempt(a, 'teacher');
    return { ok: true };
  });

  route('DELETE', '/api/attempts/:id', 'teacher', ({ params }) => {
    removeAttempt(getAttempt(params.id));
    return { ok: true };
  });

  // ------------------------------------------------------------ students

  // A student's home page: open tests for their class plus any they've started.
  function homeTests(user) {
    sweepExpired(db.all('attempts', true).filter((a) => a.studentId === user.id));
    const attempts = new Map(
      db
        .all('attempts', true)
        .filter((a) => a.studentId === user.id)
        .map((a) => [a.testId, getAttempt(a.id)]),
    );
    return {
      tests: db
        .all('tests')
        .filter((t) => t.status !== 'draft' && (attempts.has(t.id) || testVisibleTo(t, user)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((t) => {
          const a = attempts.get(t.id);
          const snap = a ? a.snapshot : t.data;
          const show = a && a.status === 'returned' && snap.settings.showResults !== 'none';
          return {
            id: t.id,
            title: snap.title,
            timeLimitMin: snap.timeLimitMin,
            extraTimePct: user.extraTimePct || 0,
            questionCount: snap.questions.filter((q) => q.type !== 'section').length,
            testOpen: t.status === 'open',
            attempt: a
              ? {
                  id: a.id,
                  status: a.status,
                  submittedAt: a.submittedAt,
                  score: show ? a.score : null,
                  maxScore: show ? a.maxScore : null,
                  hasDetails: !!show && snap.settings.showResults === 'full',
                }
              : null,
          };
        }),
    };
  }

  route('GET', '/api/my/tests', 'student', ({ user }) => homeTests(user));

  // The teacher's 👁 view of one student's home page.
  route('GET', '/api/students/:id/home', 'teacher', ({ params }) => {
    const s = db.get('students', params.id);
    if (!s) throw new HttpError(404, 'Student not found.');
    return Object.assign({ student: publicStudent(s) }, homeTests({ id: s.id, className: s.className, extraTimePct: s.extraTimePct || 0 }));
  });

  // The rules shown before starting; does not start the clock.
  route('GET', '/api/my/tests/:id/rules', 'student', ({ params, user }) => {
    const t = getTest(params.id);
    const found = db.all('attempts', true).find((x) => x.testId === t.id && x.studentId === user.id);
    if (!found && !testVisibleTo(t, user)) throw new HttpError(403, 'This test is not open for you.');
    const data = found ? getAttempt(found.id).snapshot : t.data;
    return {
      test: { title: data.title, language: data.language, timeLimitMin: data.timeLimitMin, settings: data.settings },
      accommodations: { readAloud: !!user.readAloud || data.settings.readAloudForAll, voiceAnswers: canRecord(user, data) },
    };
  });

  route('POST', '/api/my/tests/:id/start', 'student', ({ params, body, user }) => {
    const clientId = String(body.clientId || '').slice(0, 64);
    if (!clientId) throw new HttpError(400, 'Missing client id.');
    const t = getTest(params.id);
    // Locked so a double click (or two tabs) can't create two attempts.
    return withLock(() => {
      const existing = db.all('attempts', true).find((x) => x.testId === t.id && x.studentId === user.id);
      if (existing) {
        const a = getAttempt(existing.id);
        sweepExpired([a]);
        if (a.status !== 'in_progress' && a.status !== 'locked') throw new HttpError(409, 'You have already submitted this test.');
        if (a.clientId && a.clientId !== clientId) logEvent(a.id, 'reopened', 'Test opened in a new window or device', false);
        db.update('attempts', a.id, { clientId });
        a.clientId = clientId;
        return studentAttemptPayload(a, user);
      }
      if (!testVisibleTo(t, user)) throw new HttpError(403, 'This test is not open for you.');
      const started = now();
      const limitMs = t.data.timeLimitMin * 60e3 * (1 + (user.extraTimePct || 0) / 100);
      const a = db.insert('attempts', {
        testId: t.id,
        studentId: user.id,
        status: 'in_progress',
        snapshot: t.data,
        startedAt: started,
        deadlineAt: limitMs ? Math.round(started + limitMs) : null,
        clientId,
        maxScore: maxScore(t.data),
        violations: 0,
        answers: {},
        grading: {},
        feedback: '',
      });
      logEvent(a.id, 'started', '', false);
      return studentAttemptPayload(getAttempt(a.id), user);
    });
  });

  route('PUT', '/api/my/attempts/:id/answers', 'student', ({ params, body, user }) => {
    const a = ownAttempt(params.id, user);
    assertWritable(a, body.clientId);
    db.update('attempts', a.id, { answers: sanitizeAnswers(a.snapshot, body.answers) });
    return { savedAt: now(), deadlineAt: a.deadlineAt, serverNow: now() };
  });

  route('POST', '/api/my/attempts/:id/events', 'student', ({ params, body, user }) => {
    const type = String(body.type || '');
    const counted = COUNTED_EVENTS.includes(type);
    if (!counted && !LOGGED_EVENTS.includes(type)) throw new HttpError(400, 'Unknown event.');
    const run = () => {
      const a = ownAttempt(params.id, user);
      if (a.status !== 'in_progress' || (a.clientId && body.clientId !== a.clientId)) {
        return { status: a.status, violations: a.violations || 0 };
      }
      const n = db.all('events').filter((e) => e.attemptId === a.id).length;
      if (n < MAX_EVENTS_PER_ATTEMPT) logEvent(a.id, type, body.detail, counted);
      if (!counted) return { status: a.status, violations: a.violations || 0 };
      const violations = (a.violations || 0) + 1;
      db.update('attempts', a.id, { violations });
      const settings = a.snapshot.settings;
      let status = a.status;
      if (settings.maxViolations > 0 && violations >= settings.maxViolations) {
        if (settings.onLimit === 'lock') {
          db.update('attempts', a.id, { status: 'locked' });
          logEvent(a.id, 'locked', `Reached ${settings.maxViolations} warnings`, false);
          status = 'locked';
        } else if (settings.onLimit === 'submit') {
          submitAttempt(a, 'violations');
          status = 'submitted';
        }
      }
      return { status, violations, maxViolations: settings.maxViolations };
    };
    // Counting is read-modify-write, so counted events take the lock.
    return counted ? withLock(run) : run();
  });

  route('GET', '/api/my/attempts/:id/status', 'student', ({ params, user }) => {
    const a = ownAttempt(params.id, user);
    sweepExpired([a]);
    return { status: a.status, deadlineAt: a.deadlineAt, serverNow: now(), violations: a.violations || 0 };
  });

  route('POST', '/api/my/attempts/:id/recordings', 'student', ({ params, body, user }) => {
    const a = ownAttempt(params.id, user);
    assertWritable(a, body.clientId);
    if (!canRecord(user, a.snapshot)) throw new HttpError(403, 'Voice answers are not turned on for you.');
    const q = a.snapshot.questions.find((x) => x.id === body.questionId && x.type !== 'section');
    if (!q) throw new HttpError(400, 'Unknown question.');
    const mime = String(body.mime || '').split(';')[0].trim().toLowerCase();
    if (!/^audio\/(webm|ogg|mp4|mpeg|wav|aac|x-m4a)$/.test(mime)) throw new HttpError(415, 'Unsupported audio format.');
    const data = String(body.data || '');
    if (data.length < 100) throw new HttpError(400, 'The recording is empty.');
    if (data.length > MAX_AUDIO_BASE64) throw new HttpError(413, 'That recording is too long.');
    removeRecordings(recordingsOf(a.id).filter((r) => r.questionId === q.id));
    const ext = mime.split('/')[1].replace('x-m4a', 'm4a');
    const s = db.get('students', user.id) || { name: user.id };
    const fileId = files.save(`${s.name} - ${a.snapshot.title} - ${q.id}.${ext}`, mime, data);
    const duration = Math.min(3600, Math.max(0, Number(body.duration) || 0));
    const r = db.insert('recordings', { attemptId: a.id, questionId: q.id, fileId, mime, size: data.length, duration, createdAt: now() });
    return { id: r.id, questionId: q.id, duration };
  });

  route('DELETE', '/api/my/attempts/:id/recordings/:rid', 'student', ({ params, body, user }) => {
    const a = ownAttempt(params.id, user);
    assertWritable(a, body.clientId);
    removeRecordings(recordingsOf(a.id).filter((r) => r.id === params.rid));
    return { ok: true };
  });

  route('POST', '/api/my/attempts/:id/submit', 'student', ({ params, body, user }) => {
    const a = ownAttempt(params.id, user);
    if (a.status === 'submitted' || a.status === 'returned') return { status: a.status };
    // Past the deadline assertWritable submits what was autosaved and throws.
    assertWritable(a, body.clientId);
    if (body.answers) {
      a.answers = sanitizeAnswers(a.snapshot, body.answers);
      db.update('attempts', a.id, { answers: a.answers });
    }
    submitAttempt(a, body.reason === 'time' ? 'time' : 'student');
    return { status: 'submitted' };
  });

  route('GET', '/api/my/attempts/:id/result', 'student', ({ params, user }) => {
    const a = ownAttempt(params.id, user);
    const mode = a.snapshot.settings.showResults;
    if (a.status !== 'returned' || mode === 'none') throw new HttpError(403, 'Your teacher has not shared results yet.');
    const out = { title: a.snapshot.title, score: a.score, maxScore: a.maxScore, feedback: a.feedback || '', mode };
    if (mode === 'full') {
      const auto = autoGrade(a.snapshot, a.answers, recordedIds(a.id));
      out.test = a.snapshot;
      out.answers = a.answers;
      out.marks = {};
      for (const qid of Object.keys(auto)) {
        const g = a.grading[qid] || {};
        out.marks[qid] = { points: Number.isFinite(g.points) ? g.points : auto[qid].auto, max: auto[qid].max, comment: g.comment || '' };
      }
      out.recordings = recordingsOf(a.id).map((r) => ({ id: r.id, questionId: r.questionId }));
    }
    return out;
  });

  // ---------------------------------------------------------- recordings

  route('GET', '/api/recordings/:id', 'any', ({ params, user }) => {
    const r = db.get('recordings', params.id);
    const a = r && db.get('attempts', r.attemptId);
    if (!r || !a || (user.role !== 'teacher' && a.studentId !== user.id)) throw new HttpError(404, 'Recording not found.');
    return { mime: r.mime, data: files.read(r.fileId) };
  });

  // ------------------------------------------------------------ settings

  route('GET', '/api/settings', 'teacher', () => env.settings.get());

  // Keys stay on the server: the page only learns whether one is saved.
  route('PUT', '/api/settings/voices', 'teacher', ({ body }) => {
    const url = body.chatterboxUrl === undefined ? undefined : String(body.chatterboxUrl || '').trim().replace(/\/+$/, '');
    if (url) {
      if (!/^https?:\/\/[^\s"'<>]+$/.test(url)) throw new HttpError(400, 'The Chatterbox address must start with https:// (or http://).');
      if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url))
        throw new HttpError(400, 'That address only works on your own computer or network, and Google’s servers can’t reach it. Use a public address, for example from a Cloudflare tunnel (see the instructions).');
    }
    const clean = (v) => (v === undefined ? undefined : String(v || '').trim().slice(0, 500));
    env.settings.setVoices({ googleKey: clean(body.googleKey), chatterboxUrl: url, chatterboxKey: clean(body.chatterboxKey) });
    return env.settings.get();
  });

  route('PUT', '/api/settings', 'teacher', ({ body }) => {
    const url = String(body.recorderUrl || '').trim();
    if (url && !/^https:\/\/[^\s"'<>]+$/.test(url)) throw new HttpError(400, 'The recorder address must start with https://');
    env.settings.set({ recorderUrl: url });
    return env.settings.get();
  });

  // -------------------------------------------------------------- dispatch

  function handle(method, path, body, user) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.role) {
        if (!user || !user.role) throw new HttpError(403, 'You are not on the class list.');
        if (r.role !== 'any' && user.role !== r.role) throw new HttpError(403, 'Not allowed.');
      }
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return r.handler({ params, body: body || {}, user });
    }
    throw new HttpError(404, 'Not found.');
  }

  return { handle };
}

if (typeof module !== 'undefined') module.exports = { createApi, HttpError };
