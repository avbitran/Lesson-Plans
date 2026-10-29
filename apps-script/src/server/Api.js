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
  const audioReady = (id) => {
    if (!audioIds) audioIds = new Set(db.all('audio', true).map((x) => x.id));
    return audioIds.has(id);
  };

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

  // --- who may see what. The admin (whoever set up the app) sees everything;
  // every other teacher sees their own classes, tests and those students.
  const isAdmin = (user) => user.role === 'teacher' && !!user.admin;
  const ownsTest = (user, t) => isAdmin(user) || t.ownerId === user.id;
  const classesOf = (user) => db.all('classes').filter((c) => isAdmin(user) || c.ownerId === user.id);

  function myTest(user, id) {
    const t = getTest(id);
    if (!ownsTest(user, t)) throw new HttpError(404, 'Test not found.');
    return t;
  }

  // Sharing: '' = nobody, '*' = every teacher, else a comma-separated list of
  // teacher emails. Shared teachers may look at the test (student view) and
  // make their own copy; they never see its results or change it.
  const sharedList = (t) => String(t.sharedWith || '').split(',').map((x) => x.trim()).filter(Boolean);
  const sharedWithUser = (user, t) => t.ownerId !== user.id && (t.sharedWith === '*' || sharedList(t).includes(user.id));
  function viewableTest(user, id) {
    const t = getTest(id);
    if (!ownsTest(user, t) && !sharedWithUser(user, t)) throw new HttpError(404, 'Test not found.');
    return t;
  }

  function myClass(user, id) {
    const c = db.get('classes', String(id));
    if (!c || !(isAdmin(user) || c.ownerId === user.id)) throw new HttpError(404, 'Class not found.');
    return c;
  }

  function myAttempt(user, id) {
    const a = getAttempt(id);
    const t = db.get('tests', a.testId);
    if (!isAdmin(user) && (!t || t.ownerId !== user.id)) throw new HttpError(404, 'Attempt not found.');
    return a;
  }

  // Students in any of this teacher's classes (joined or waiting for approval).
  function teacherCanSeeStudent(user, studentId) {
    if (isAdmin(user)) return true;
    const mine = new Set(classesOf(user).map((c) => c.id));
    return db.all('members').some((m) => m.studentId === studentId && mine.has(m.classId));
  }

  const activeClassIds = (studentId) =>
    new Set(db.all('members').filter((m) => m.studentId === studentId && m.status === 'active').map((m) => m.classId));

  // The classes a test is for: the ones picked, or all of its owner's classes.
  function testClassIds(t) {
    const picked = (t.data.classIds || []).filter(Boolean);
    if (picked.length) return new Set(picked);
    return new Set(db.all('classes').filter((c) => c.ownerId === t.ownerId).map((c) => c.id));
  }

  function testVisibleTo(t, user, studentClasses) {
    if (t.status !== 'open') return false;
    const mine = studentClasses || activeClassIds(user.id);
    for (const id of testClassIds(t)) if (mine.has(id)) return true;
    return false;
  }

  // Join codes are short, unambiguous and case-insensitive: ENG-4821.
  const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  function newJoinCode(name) {
    const prefix = (String(name || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'CLS').padEnd(3, 'X');
    const taken = new Set(db.all('classes').map((c) => normalizeCode(c.joinCode)));
    for (;;) {
      const code = `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
      if (!taken.has(normalizeCode(code))) return code;
    }
  }

  function addMember(classId, studentId, status) {
    const existing = db.all('members').find((m) => m.classId === classId && m.studentId === studentId);
    if (existing) {
      if (existing.status !== status && status === 'active') db.update('members', existing.id, { status: 'active' });
      return existing.status === 'active' ? 'active' : status;
    }
    db.insert('members', { classId, studentId, status, addedAt: now() });
    return status;
  }

  // Names to show instead of (often numeric) school emails.
  const localPart = (email) => String(email || '').split('@')[0];
  function teacherName(email) {
    const t = db.get('teachers', email);
    return (t && t.name) || localPart(email);
  }
  const isPlaceholderName = (s) => !s.name || s.name === localPart(s.id);

  function ensureStudent(email, name) {
    const s = db.get('students', email);
    if (s) return s;
    return db.insert('students', {
      id: email,
      name: String(name || '').trim().slice(0, 100) || email.split('@')[0],
      className: '',
      readAloud: false,
      voiceAnswers: false,
      extraTimePct: 0,
      createdAt: now(),
    });
  }

  function classNamesFor(studentId, user) {
    const classes = new Map(db.all('classes').map((c) => [c.id, c]));
    return db
      .all('members')
      .filter((m) => m.studentId === studentId && classes.has(m.classId))
      .map((m) => classes.get(m.classId))
      .filter((c) => !user || isAdmin(user) || c.ownerId === user.id)
      .map((c) => c.name)
      .join(', ');
  }

  function sanitizeAnswers(test, input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const q of test.questions) {
      if (q.type === 'section' || !(q.id in input)) continue;
      const v = input[q.id];
      if (q.type === 'vocab') {
        // One pick per definition: an item number (0-based) or null.
        if (Array.isArray(v)) out[q.id] = q.pairs.map((p, k) => (Number.isInteger(v[k]) && v[k] >= 0 && v[k] < q.items.length ? v[k] : null));
        continue;
      }
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

  function publicStudent(s, user) {
    return {
      id: s.id,
      email: s.id,
      name: s.name,
      className: classNamesFor(s.id, user),
      readAloud: !!s.readAloud,
      voiceAnswers: !!s.voiceAnswers,
      extraTimePct: s.extraTimePct || 0,
    };
  }

  // ---------------------------------------------------------------- me

  route('GET', '/api/me', null, (ctx) => ({ user: ctx.user }));

  // ------------------------------------------------------ teacher: classes

  function classPayload(c, members, students) {
    return {
      id: c.id,
      name: c.name,
      ownerId: c.ownerId,
      ownerName: teacherName(c.ownerId),
      joinCode: c.joinCode,
      joinMode: c.joinMode || 'off',
      classroomId: c.classroomId || '',
      students: members
        .filter((m) => m.classId === c.id)
        .map((m) => Object.assign(publicStudent(students.get(m.studentId) || { id: m.studentId, name: m.studentId }), { status: m.status, memberId: m.id }))
        .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'pending' ? -1 : 1)),
    };
  }

  route('GET', '/api/classes', 'teacher', ({ user }) => {
    const members = db.all('members');
    const students = new Map(db.all('students').map((s) => [s.id, s]));
    return {
      classes: classesOf(user)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => classPayload(c, members, students)),
      classroomAvailable: !!env.classroom && user.id === ownerEmail(),
      // The owner sees how to turn Classroom import on when it's off.
      classroomNeedsSetup: !env.classroom && user.id === ownerEmail(),
    };
  });

  route('POST', '/api/classes', 'teacher', ({ body, user }) => {
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Give the class a name, for example "10-3 English".');
    const c = db.insert('classes', { ownerId: user.id, name, joinCode: newJoinCode(name), joinMode: 'off', classroomId: '', createdAt: now() });
    return { id: c.id };
  });

  route('PUT', '/api/classes/:id', 'teacher', ({ params, body, user }) => {
    const c = myClass(user, params.id);
    const patch = {};
    if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 60) || c.name;
    if (['off', 'open', 'approve'].includes(body.joinMode)) patch.joinMode = body.joinMode;
    if (body.newCode) patch.joinCode = newJoinCode(patch.name || c.name);
    db.update('classes', c.id, patch);
    return { ok: true };
  });

  route('DELETE', '/api/classes/:id', 'teacher', ({ params, user }) => {
    const c = myClass(user, params.id);
    db.removeWhere('members', (m) => m.classId === c.id);
    db.remove('classes', c.id);
    return { ok: true };
  });

  route('POST', '/api/classes/:id/students', 'teacher', ({ params, body, user }) => {
    const c = myClass(user, params.id);
    const people = Array.isArray(body.people) ? body.people.slice(0, 500) : [];
    let added = 0;
    const skipped = [];
    for (const p of people) {
      const email = cleanEmail(p.email);
      if (!isEmail(email)) {
        skipped.push(`${p.email || '(empty)'}: not an email address`);
        continue;
      }
      const s = ensureStudent(email, p.name);
      if (p.name && String(p.name).trim() && isPlaceholderName(s)) db.update('students', email, { name: String(p.name).trim().slice(0, 100) });
      addMember(c.id, email, 'active');
      added++;
    }
    return { added, skipped };
  });

  route('POST', '/api/classes/:id/students/:sid/approve', 'teacher', ({ params, user }) => {
    const c = myClass(user, params.id);
    const m = db.all('members').find((x) => x.classId === c.id && x.studentId === params.sid);
    if (!m) throw new HttpError(404, 'Student not found in this class.');
    db.update('members', m.id, { status: 'active' });
    return { ok: true };
  });

  route('DELETE', '/api/classes/:id/students/:sid', 'teacher', ({ params, user }) => {
    const c = myClass(user, params.id);
    db.removeWhere('members', (m) => m.classId === c.id && m.studentId === params.sid);
    return { ok: true };
  });

  // Google Classroom: only the person who set up the app can import, because
  // Google runs the app with their account and sees their Classroom.
  route('GET', '/api/classroom/courses', 'teacher', ({ user }) => {
    if (!env.classroom || user.id !== ownerEmail()) throw new HttpError(403, CLASSROOM_OWNER_ONLY);
    return { courses: env.classroom.courses() };
  });

  route('POST', '/api/classes/:id/classroom', 'teacher', ({ params, body, user }) => {
    if (!env.classroom || user.id !== ownerEmail()) throw new HttpError(403, CLASSROOM_OWNER_ONLY);
    const c = myClass(user, params.id);
    const courseId = String(body.courseId || c.classroomId || '');
    if (!courseId) throw new HttpError(400, 'Choose a Classroom class.');
    const roster = env.classroom.students(courseId);
    if (roster.length && roster.every((p) => !p.email)) throw new HttpError(403, CLASSROOM_NO_EMAILS);
    let added = 0;
    const skipped = [];
    for (const p of roster) {
      const email = cleanEmail(p.email);
      if (!isEmail(email)) {
        skipped.push(`${p.name || 'A student'}: Classroom did not share their email`);
        continue;
      }
      const s = ensureStudent(email, p.name);
      if (p.name && isPlaceholderName(s)) db.update('students', email, { name: String(p.name).trim().slice(0, 100) });
      if (addMember(c.id, email, 'active')) added++;
    }
    db.update('classes', c.id, { classroomId: courseId });
    return { added, skipped, total: roster.length };
  });

  route('PUT', '/api/students/:id', 'teacher', ({ params, body, user }) => {
    const s = db.get('students', params.id);
    if (!s || !teacherCanSeeStudent(user, s.id)) throw new HttpError(404, 'Student not found.');
    const patch = {};
    if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 100) || s.name;
    if (body.readAloud !== undefined) patch.readAloud = !!body.readAloud;
    if (body.voiceAnswers !== undefined) patch.voiceAnswers = !!body.voiceAnswers;
    if (body.extraTimePct !== undefined) patch.extraTimePct = Math.min(200, Math.max(0, parseInt(body.extraTimePct, 10) || 0));
    db.update('students', s.id, patch);
    return { student: publicStudent(db.get('students', s.id), user) };
  });

  // Deleting a student (and all their work) is for the admin; teachers
  // remove students from their classes instead.
  route('DELETE', '/api/students/:id', 'teacher', ({ params, user }) => {
    if (!isAdmin(user)) throw new HttpError(403, 'Only the admin can delete a student. Remove them from your class instead.');
    for (const a of db.all('attempts', true).filter((x) => x.studentId === params.id)) removeAttempt(a);
    db.removeWhere('members', (m) => m.studentId === params.id);
    db.remove('students', params.id);
    return { ok: true };
  });

  // ------------------------------------------------------- admin: sharing

  route('POST', '/api/admin/install-copy', 'teacher', ({ user }) => {
    if (!isAdmin(user)) throw new HttpError(403, 'Only the admin can make an installable copy.');
    return env.makeInstallCopy();
  });

  // -------------------------------------------------------- admin: backups

  const adminOnly = (user) => {
    if (!isAdmin(user)) throw new HttpError(403, 'Only the admin manages backups.');
  };
  route('GET', '/api/backups', 'teacher', ({ user }) => (adminOnly(user), env.backups.status()));
  route('POST', '/api/backups', 'teacher', ({ user }) => {
    adminOnly(user);
    const made = env.backups.now();
    return Object.assign(env.backups.status(), { made });
  });
  route('PUT', '/api/backups', 'teacher', ({ body, user }) => {
    adminOnly(user);
    env.backups.setDaily(!!body.daily);
    return env.backups.status();
  });

  // ------------------------------------------------------- admin: teachers

  route('GET', '/api/teachers', 'teacher', ({ user }) => {
    if (!isAdmin(user)) throw new HttpError(403, 'Only the admin manages teachers.');
    const classes = db.all('classes');
    const tests = db.all('tests', true);
    const row = (email, admin) => ({
      id: email,
      email,
      name: teacherName(email),
      admin,
      classes: classes.filter((c) => c.ownerId === email).length,
      tests: tests.filter((t) => t.ownerId === email).length,
    });
    return {
      teachers: [row(ownerEmail(), true)].concat(db.all('teachers').filter((t) => t.id !== ownerEmail()).map((t) => row(t.id, false))),
    };
  });

  route('POST', '/api/teachers', 'teacher', ({ body, user }) => {
    if (!isAdmin(user)) throw new HttpError(403, 'Only the admin manages teachers.');
    const email = cleanEmail(body.email);
    if (!isEmail(email)) throw new HttpError(400, 'Enter an email address.');
    if (email !== ownerEmail() && !db.get('teachers', email)) db.insert('teachers', { id: email, name: String(body.name || '').trim().slice(0, 100), addedAt: now() });
    return { ok: true };
  });

  route('PUT', '/api/teachers/:id', 'teacher', ({ params, body, user }) => {
    if (!isAdmin(user) && params.id !== user.id) throw new HttpError(403, 'Only the admin changes other teachers.');
    setTeacherName(params.id, body.name);
    return { ok: true };
  });

  // Every teacher can set their own name (shown instead of their email).
  function setTeacherName(email, name) {
    const clean = String(name || '').trim().slice(0, 100);
    if (email !== ownerEmail() && !db.get('teachers', email)) throw new HttpError(404, 'Teacher not found.');
    if (db.get('teachers', email)) db.update('teachers', email, { name: clean });
    else db.insert('teachers', { id: email, name: clean, addedAt: now() }); // the admin's own row
  }
  route('PUT', '/api/me/name', 'teacher', ({ body, user }) => {
    if (!String(body.name || '').trim()) throw new HttpError(400, 'Write your name.');
    setTeacherName(user.id, body.name);
    return { name: teacherName(user.id) };
  });

  // Names of all teachers, for choosing whom to share a test with.
  route('GET', '/api/teachers/names', 'teacher', () => ({
    teachers: [ownerEmail()]
      .concat(db.all('teachers').map((t) => t.id).filter((e) => e !== ownerEmail()))
      .map((email) => ({ email, name: teacherName(email) })),
  }));

  route('DELETE', '/api/teachers/:id', 'teacher', ({ params, user }) => {
    if (!isAdmin(user)) throw new HttpError(403, 'Only the admin manages teachers.');
    if (params.id === ownerEmail()) throw new HttpError(400, 'The person who set up the app is always the admin.');
    db.remove('teachers', params.id);
    return { ok: true };
  });

  // ------------------------------------------------------- teacher: tests

  // Only class ids this teacher owns may be put on a test.
  function cleanClassIds(user, data) {
    const mine = new Set(classesOf(user).map((c) => c.id));
    data.classIds = (data.classIds || []).filter((id) => mine.has(id));
    return data;
  }

  route('GET', '/api/tests', 'teacher', ({ user }) => {
    sweepExpired(db.all('attempts', true));
    const fresh = db.all('attempts', true);
    const classNames = new Map(db.all('classes').map((c) => [c.id, c.name]));
    return {
      tests: db
        .all('tests')
        .filter((t) => ownsTest(user, t) || sharedWithUser(user, t))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((t) => {
          const shared = !ownsTest(user, t);
          const mine = shared ? [] : fresh.filter((a) => a.testId === t.id);
          return {
            shared,
            sharing: t.sharedWith === '*' ? 'all' : sharedList(t).length ? `${sharedList(t).length}` : '',
            id: t.id,
            title: t.title,
            status: t.status,
            updatedAt: t.updatedAt,
            ownerId: t.ownerId,
            ownerName: teacherName(t.ownerId),
            classes: (t.data.classIds || []).map((id) => classNames.get(id)).filter(Boolean),
            questionCount: t.data.questions.filter((q) => q.type !== 'section').length,
            active: mine.filter((a) => a.status === 'in_progress' || a.status === 'locked').length,
            toGrade: mine.filter((a) => a.status === 'submitted').length,
            returned: mine.filter((a) => a.status === 'returned').length,
          };
        }),
    };
  });

  route('POST', '/api/tests', 'teacher', ({ body, user }) => {
    const data = cleanClassIds(user, normalizeTest(body.data));
    const t = db.insert('tests', { ownerId: user.id, title: data.title, status: 'draft', data, updatedAt: now() });
    return { id: t.id };
  });

  route('GET', '/api/tests/:id', 'teacher', ({ params, user }) => {
    const t = viewableTest(user, params.id);
    return { id: t.id, status: t.status, data: t.data, ownerId: t.ownerId, canEdit: ownsTest(user, t), sharedWith: ownsTest(user, t) ? t.sharedWith || '' : undefined };
  });

  route('PUT', '/api/tests/:id/share', 'teacher', ({ params, body, user }) => {
    const t = myTest(user, params.id);
    let value = '';
    if (body.mode === 'all') value = '*';
    else if (body.mode === 'some') {
      const known = new Set([ownerEmail()].concat(db.all('teachers').map((x) => x.id)));
      value = [...new Set((Array.isArray(body.teachers) ? body.teachers : []).map(cleanEmail))].filter((e) => known.has(e) && e !== t.ownerId).join(',');
    }
    db.update('tests', t.id, { sharedWith: value });
    return { sharedWith: value };
  });

  route('PUT', '/api/tests/:id', 'teacher', ({ params, body, user }) => {
    const t = myTest(user, params.id);
    // The owner's classes decide who may be picked, even when the admin edits.
    const owner = t.ownerId === user.id ? user : { id: t.ownerId, role: 'teacher' };
    const data = body.data !== undefined ? cleanClassIds(owner, normalizeTest(body.data)) : t.data;
    const status = ['draft', 'open', 'closed'].includes(body.status) ? body.status : t.status;
    db.update('tests', t.id, { title: data.title, status, data, updatedAt: now() });
    return { id: t.id, status, data };
  });

  route('POST', '/api/tests/:id/duplicate', 'teacher', ({ params, user }) => {
    const t = viewableTest(user, params.id);
    const data = cleanClassIds(user, Object.assign({}, t.data, { title: `${t.data.title} (copy)`.slice(0, 200) }));
    const copy = db.insert('tests', { ownerId: user.id, title: data.title, status: 'draft', data, updatedAt: now() });
    return { id: copy.id };
  });

  route('DELETE', '/api/tests/:id', 'teacher', ({ params, user }) => {
    const t = myTest(user, params.id);
    for (const a of db.all('attempts', true).filter((x) => x.testId === t.id)) removeAttempt(a);
    db.remove('tests', t.id);
    return { ok: true };
  });

  route('GET', '/api/tests/:id/preview', 'teacher', ({ params, user }) => ({ test: viewOf(viewableTest(user, params.id).data) }));

  route('GET', '/api/tests/:id/audio', 'teacher', ({ params, user }) => audioStatus(myTest(user, params.id).data));

  // Makes missing natural-voice audio for a test, for up to ~40 seconds per
  // call; the page keeps calling until nothing is missing.
  route('POST', '/api/tests/:id/audio', 'teacher', ({ params, user }) => {
    const test = myTest(user, params.id).data;
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
    const t = getTest(testId);
    const forTest = testClassIds(t);
    const classById = new Map(db.all('classes').map((c) => [c.id, c.name]));
    const members = db.all('members');
    // The student's class(es) among the ones this test is for.
    const classNames = (sid) =>
      members
        .filter((m) => m.studentId === sid && forTest.has(m.classId))
        .map((m) => classById.get(m.classId))
        .join(', ');
    const students = new Map(db.all('students').map((s) => [s.id, s]));
    const recs = db.all('recordings');
    return db
      .all('attempts')
      .filter((a) => a.testId === testId)
      .map((a) => {
        const s = students.get(a.studentId) || { name: a.studentId };
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
          className: classNames(a.studentId),
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

  route('GET', '/api/tests/:id/attempts', 'teacher', ({ params, user }) => {
    const t = myTest(user, params.id);
    const attempts = attemptRows(t.id);
    const started = new Set(attempts.map((a) => a.studentId));
    const forTest = testClassIds(t);
    const classById = new Map(db.all('classes').map((c) => [c.id, c.name]));
    const students = new Map(db.all('students').map((s) => [s.id, s]));
    const waiting = new Map();
    for (const m of db.all('members')) {
      if (m.status !== 'active' || !forTest.has(m.classId) || started.has(m.studentId) || waiting.has(m.studentId)) continue;
      const s = students.get(m.studentId);
      if (s) waiting.set(s.id, { id: s.id, name: s.name, className: classById.get(m.classId) || '' });
    }
    const notStarted = [...waiting.values()].sort((a, b) => (a.className + a.name).localeCompare(b.className + b.name));
    return { test: { id: t.id, title: t.title, status: t.status, data: t.data }, attempts, notStarted };
  });

  route('POST', '/api/tests/:id/export', 'teacher', ({ params, user }) => {
    const t = myTest(user, params.id);
    const iso = (ms) => (ms ? (env.formatTime ? env.formatTime(ms) : new Date(ms).toISOString().replace('T', ' ').slice(0, 16)) : '');
    const rows = [['Name', 'Email', 'Class', 'Status', 'Score', 'Max', 'Started', 'Submitted', 'Times left the test']];
    for (const a of attemptRows(t.id))
      rows.push([a.name, a.email, a.className, a.status, a.score != null ? a.score : '', a.maxScore, iso(a.startedAt), iso(a.submittedAt), a.violations]);
    return { url: exportResults(t.title, rows) };
  });

  // ---------------------------------------------------- teacher: attempts

  route('GET', '/api/attempts/:id', 'teacher', ({ params, user }) => {
    const a = myAttempt(user, params.id);
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
      student: publicStudent(s, user),
      events: db
        .all('events')
        .filter((e) => e.attemptId === a.id)
        .sort((x, y) => x.at - y.at)
        .map((e) => ({ at: e.at, type: e.type, detail: e.detail, counted: !!e.counted })),
      recordings: recordingsOf(a.id).map((r) => ({ id: r.id, questionId: r.questionId, duration: r.duration, createdAt: r.createdAt })),
    };
  });

  route('PUT', '/api/attempts/:id/grade', 'teacher', ({ params, body, user }) => {
    const a = myAttempt(user, params.id);
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

  route('POST', '/api/attempts/:id/unlock', 'teacher', ({ params, body, user }) => {
    const a = myAttempt(user, params.id);
    if (a.status !== 'locked' && a.status !== 'in_progress') throw new HttpError(409, 'This test is already submitted.');
    const add = Math.min(240, Math.max(0, parseInt(body.addMinutes, 10) || 0));
    const deadline = a.deadlineAt ? Math.max(a.deadlineAt, now()) + add * 60e3 : null;
    db.update('attempts', a.id, { status: 'in_progress', deadlineAt: deadline });
    logEvent(a.id, 'unlocked', add ? `+${add} min` : '', false);
    return { ok: true };
  });

  route('POST', '/api/attempts/:id/force-submit', 'teacher', ({ params, user }) => {
    const a = myAttempt(user, params.id);
    if (a.status !== 'locked' && a.status !== 'in_progress') throw new HttpError(409, 'This test is already submitted.');
    submitAttempt(a, 'teacher');
    return { ok: true };
  });

  route('DELETE', '/api/attempts/:id', 'teacher', ({ params, user }) => {
    removeAttempt(myAttempt(user, params.id));
    return { ok: true };
  });

  // ------------------------------------------------------------ students

  // A student's home page: open tests for their class plus any they've started.
  function homeTests(user, onlyOwner) {
    sweepExpired(db.all('attempts', true).filter((a) => a.studentId === user.id));
    const studentClasses = activeClassIds(user.id);
    const attempts = new Map(
      db
        .all('attempts', true)
        .filter((a) => a.studentId === user.id)
        .map((a) => [a.testId, getAttempt(a.id)]),
    );
    return {
      tests: db
        .all('tests')
        .filter((t) => t.status !== 'draft' && (attempts.has(t.id) || testVisibleTo(t, user, studentClasses)))
        .filter((t) => !onlyOwner || t.ownerId === onlyOwner)
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

  function myClassesPayload(studentId) {
    const classes = new Map(db.all('classes').map((c) => [c.id, c]));
    return db
      .all('members')
      .filter((m) => m.studentId === studentId && classes.has(m.classId))
      .map((m) => ({ name: classes.get(m.classId).name, status: m.status }));
  }

  route('GET', '/api/my/tests', 'student', ({ user }) => Object.assign(homeTests(user), { classes: myClassesPayload(user.id) }));

  // The teacher's 👁 view of one student's home page (only their own tests,
  // unless they're the admin).
  route('GET', '/api/students/:id/home', 'teacher', ({ params, user }) => {
    const s = db.get('students', params.id);
    if (!s || !teacherCanSeeStudent(user, s.id)) throw new HttpError(404, 'Student not found.');
    const home = homeTests({ id: s.id, extraTimePct: s.extraTimePct || 0 }, isAdmin(user) ? null : user.id);
    return Object.assign({ student: publicStudent(s, user) }, home);
  });

  // A student (or someone not on any list yet) joins a class with its code.
  route('POST', '/api/join', 'signed-in', ({ body, user }) => {
    if (user.role === 'teacher') throw new HttpError(400, 'Teachers don’t join classes. Use a student account to try this.');
    const code = normalizeCode(body.code);
    const c = code && db.all('classes').find((x) => normalizeCode(x.joinCode) === code);
    if (!c || (c.joinMode || 'off') === 'off') throw new HttpError(404, 'That class code doesn’t work. Check it with your teacher.');
    const name = String(body.name || '').trim();
    if (!db.get('students', user.email) && name.length < 2) throw new HttpError(400, 'Write your full name so your teacher knows who you are.');
    return withLock(() => {
      ensureStudent(user.email, name);
      const status = addMember(c.id, user.email, c.joinMode === 'approve' ? 'pending' : 'active');
      return { className: c.name, status };
    });
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
    const t = a && db.get('tests', a.testId);
    const allowed = a && (user.role === 'teacher' ? isAdmin(user) || (t && t.ownerId === user.id) : a.studentId === user.id);
    if (!r || !allowed) throw new HttpError(404, 'Recording not found.');
    return { mime: r.mime, data: files.read(r.fileId) };
  });

  // ------------------------------------------------------------ settings

  route('GET', '/api/settings', 'teacher', () => env.settings.get());

  // Keys stay on the server: the page only learns whether one is saved.
  route('PUT', '/api/settings/voices', 'teacher', ({ body, user }) => {
    if (!isAdmin(user)) throw new HttpError(403, 'Only the admin changes settings.');
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

  route('PUT', '/api/settings', 'teacher', ({ body, user }) => {
    if (!isAdmin(user)) throw new HttpError(403, 'Only the admin changes settings.');
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
      if (r.role === 'signed-in') {
        if (!user || !user.email) throw new HttpError(403, 'Sign in with your school Google account.');
      } else if (r.role) {
        if (!user || !user.role || user.role === 'guest') throw new HttpError(403, 'You are not in a class yet.');
        if (r.role !== 'any' && user.role !== r.role) throw new HttpError(403, 'Not allowed.');
      }
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return r.handler({ params, body: body || {}, user });
    }
    throw new HttpError(404, 'Not found.');
  }

  // One-time upgrade from the single-teacher version: each class name the
  // students had becomes a class owned by the admin, and tests point at those
  // classes. Only adds rows; existing answers and scores are not touched.
  function migrate() {
    const owner = ownerEmail();
    const byName = new Map(db.all('classes').filter((c) => c.ownerId === owner).map((c) => [c.name.toLowerCase(), c]));
    const classFor = (name) => {
      const key = name.toLowerCase();
      if (!byName.has(key)) byName.set(key, db.insert('classes', { ownerId: owner, name, joinCode: newJoinCode(name), joinMode: 'off', classroomId: '', createdAt: now() }));
      return byName.get(key);
    };
    const hasMembership = new Set(db.all('members').map((m) => m.studentId));
    for (const s of db.all('students')) {
      if (hasMembership.has(s.id)) continue;
      addMember(classFor(String(s.className || '').trim() || 'My students').id, s.id, 'active');
    }
    for (const t of db.all('tests')) {
      const patch = {};
      if (!t.ownerId) patch.ownerId = owner;
      if (!Array.isArray(t.data.classIds)) {
        const names = (t.data.classes || []).map((n) => String(n).trim()).filter(Boolean);
        patch.data = Object.assign({}, t.data, { classIds: names.map((n) => classFor(n).id) });
      }
      if (Object.keys(patch).length) db.update('tests', t.id, patch);
    }
  }

  return { handle, migrate };
}

const CLASSROOM_NO_EMAILS =
  'Google Classroom didn’t share the students’ email addresses. Update the app’s manifest (appsscript.json) as in the update instructions, run "authorize" once, and allow every permission.';

const CLASSROOM_OWNER_ONLY =
  'Google Classroom import works only for the person who set up the app (Google runs the app with their account). Use the class code instead.';

if (typeof module !== 'undefined') module.exports = { createApi, HttpError };
