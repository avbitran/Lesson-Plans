import { api, h, clear, header, requireUser, toast, modal, fmtDate, fmtTime, fmtDuration, LETTERS, isRtl } from './common.js';

const app = document.getElementById('app');
let user;
let refreshTimer = null;

const NAV = [
  ['Tests', '#tests'],
  ['Students', '#people'],
];

function page(...children) {
  clear(app, header(user, NAV), h('main', { class: 'wrap' }, children));
}

const STATUS_LABEL = { draft: 'Draft', open: 'Open', closed: 'Closed' };
const ATTEMPT_LABEL = { in_progress: 'Working', locked: 'Paused', submitted: 'To grade', returned: 'Returned' };

// ===================================================================== tests

async function testsPage() {
  const { tests } = await api('GET', '/api/tests');
  const importInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const { id } = await api('POST', '/api/tests', { data });
      toast('Test imported.', 'ok');
      location.hash = `#edit/${id}`;
    } catch (e) {
      toast(`Could not import: ${e.message}`, 'error');
    }
  });
  page(
    h(
      'div',
      { class: 'page-head' },
      h('h1', { text: 'Tests' }),
      h(
        'div',
        { class: 'row' },
        importInput,
        h('button', { class: 'btn', onclick: () => importInput.click() }, 'Import JSON'),
        h('a', { class: 'btn btn-primary', href: '#edit/new' }, '+ New test'),
      ),
    ),
    tests.length
      ? h(
          'table',
          { class: 'table' },
          h('thead', {}, h('tr', {}, ['Test', 'Status', 'Classes', 'Working now', 'To grade', 'Returned', ''].map((x) => h('th', { text: x })))),
          h(
            'tbody',
            {},
            tests.map((t) =>
              h(
                'tr',
                {},
                h('td', {}, h('a', { href: `#results/${t.id}`, class: 'strong', text: t.title }), h('div', { class: 'muted small', text: `${t.questionCount} questions · edited ${fmtDate(t.updatedAt)}` })),
                h('td', {}, h('span', { class: `badge badge-${t.status}`, text: STATUS_LABEL[t.status] })),
                h('td', { text: t.classes.join(', ') || 'All students' }),
                h('td', { text: t.active || '' }),
                h('td', {}, t.toGrade ? h('span', { class: 'badge badge-warn', text: t.toGrade }) : ''),
                h('td', { text: t.returned || '' }),
                h('td', {}, h('div', { class: 'row tight' }, h('a', { class: 'btn btn-ghost', href: `#edit/${t.id}` }, 'Edit'), h('a', { class: 'btn btn-ghost', href: `#results/${t.id}` }, 'Results')),
              )),
            ),
          ),
        )
      : h(
          'div',
          { class: 'card' },
          h('p', { text: 'No tests yet. Create one, or import the sample test from the samples folder.' }),
        ),
  );
}

// ==================================================================== editor

const uid = () => 'q' + Math.random().toString(36).slice(2, 9);

function blankTest() {
  return {
    title: '',
    instructions: '',
    language: 'en-US',
    timeLimitMin: 30,
    classes: [],
    settings: {
      requireFullscreen: true,
      maxViolations: 3,
      onLimit: 'lock',
      blockCopyPaste: true,
      readAloudForAll: false,
      recordingForAll: false,
      showResults: 'score',
    },
    questions: [],
  };
}

function newQuestion(type) {
  const q = { id: uid(), type, title: '', prompt: '' };
  if (type === 'section') return q;
  q.points = type === 'long' ? 5 : 1;
  if (type === 'mc') {
    q.options = ['', ''];
    q.correct = 0;
  }
  if (type === 'short') q.accepted = [];
  if (type === 'long') q.modelAnswer = '';
  return q;
}

const TYPE_LABEL = { section: 'Text / reading passage', mc: 'Multiple choice', short: 'Short answer (auto-marked)', long: 'Open answer (you mark it)' };

async function editorPage(id) {
  let status = 'draft';
  let data;
  if (id === 'new') data = blankTest();
  else {
    const r = await api('GET', `/api/tests/${id}`);
    data = r.data;
    status = r.status;
  }
  let dirty = false;
  const touch = () => (dirty = true);

  const bind = (obj, key, el, conv = (v) => v) => {
    el.addEventListener('input', () => {
      obj[key] = conv(el.type === 'checkbox' ? el.checked : el.value);
      touch();
    });
    el.addEventListener('change', () => {
      obj[key] = conv(el.type === 'checkbox' ? el.checked : el.value);
      touch();
    });
    return el;
  };
  const field = (label, el, hint) => h('label', {}, h('span', { text: label }), el, hint ? h('small', { class: 'muted', text: hint }) : null);
  const s = data.settings;

  const qList = h('div', { class: 'q-editor-list' });

  function questionEditor(q, index) {
    const move = (d) => {
      const j = index + d;
      if (j < 0 || j >= data.questions.length) return;
      [data.questions[index], data.questions[j]] = [data.questions[j], data.questions[index]];
      touch();
      drawQuestions();
    };
    const body = h('div', { class: 'form' });
    if (q.type === 'section') {
      body.append(
        field('Heading (optional)', bind(q, 'title', h('input', { value: q.title }))),
        field('Text students read (instructions, a story, a passage…)', bind(q, 'prompt', h('textarea', { rows: 5, value: q.prompt }))),
      );
    } else {
      body.append(
        field('Question', bind(q, 'prompt', h('textarea', { rows: 2, value: q.prompt }))),
        h('div', { class: 'row' }, field('Points', bind(q, 'points', h('input', { type: 'number', min: 0, step: 0.5, value: q.points, class: 'narrow-input' }), Number))),
      );
    }
    if (q.type === 'mc') {
      const opts = h('div', { class: 'mc-options' });
      const drawOpts = () => {
        clear(
          opts,
          h('span', { class: 'small muted', text: 'Options — select the correct one' }),
          q.options.map((o, i) =>
            h(
              'div',
              { class: 'row tight' },
              h('input', {
                type: 'radio',
                name: `correct-${q.id}`,
                checked: q.correct === i,
                'aria-label': `Option ${LETTERS[i]} is correct`,
                onchange: () => ((q.correct = i), touch()),
              }),
              h('span', { class: 'letter', text: LETTERS[i] }),
              bind(q.options, i, h('input', { value: o, class: 'grow', placeholder: `Option ${LETTERS[i]}` })),
              q.options.length > 2
                ? h('button', {
                    class: 'btn btn-ghost',
                    type: 'button',
                    'aria-label': 'Remove option',
                    onclick: () => {
                      q.options.splice(i, 1);
                      if (q.correct >= q.options.length) q.correct = 0;
                      else if (q.correct > i) q.correct--;
                      touch();
                      drawOpts();
                    },
                  }, '✕')
                : null,
            ),
          ),
          q.options.length < 12 ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => (q.options.push(''), touch(), drawOpts()) }, '+ Option') : null,
        );
      };
      drawOpts();
      body.append(opts);
    }
    if (q.type === 'short') {
      const ta = h('textarea', { rows: 2, value: (q.accepted || []).join('\n'), placeholder: "was watching\nwere watching" });
      ta.addEventListener('input', () => {
        q.accepted = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
        touch();
      });
      body.append(field('Accepted answers — one per line', ta, 'Capital letters, extra spaces, curly apostrophes and a final full stop are ignored. Answers that match nothing are flagged for you to check.'));
    }
    if (q.type === 'long') {
      body.append(field('Model answer / marking guide (only you see this)', bind(q, 'modelAnswer', h('textarea', { rows: 3, value: q.modelAnswer || '' }))));
    }
    return h(
      'div',
      { class: `card q-editor q-editor-${q.type}` },
      h(
        'div',
        { class: 'q-editor-head' },
        h('strong', { text: TYPE_LABEL[q.type] }),
        h(
          'div',
          { class: 'row tight' },
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => move(-1), 'aria-label': 'Move up' }, '↑'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => move(1), 'aria-label': 'Move down' }, '↓'),
          h('button', {
            class: 'btn btn-ghost',
            type: 'button',
            onclick: () => {
              data.questions.splice(index + 1, 0, { ...structuredClone(q), id: uid() });
              touch();
              drawQuestions();
            },
          }, 'Duplicate'),
          h('button', {
            class: 'btn btn-ghost danger',
            type: 'button',
            onclick: () => {
              data.questions.splice(index, 1);
              touch();
              drawQuestions();
            },
          }, 'Delete'),
        ),
      ),
      body,
    );
  }

  function totalPoints() {
    return data.questions.reduce((sum, q) => sum + (q.type === 'section' ? 0 : Number(q.points) || 0), 0);
  }

  function drawQuestions() {
    clear(
      qList,
      data.questions.map((q, i) => questionEditor(q, i)),
      h(
        'div',
        { class: 'card add-row' },
        h('span', { class: 'muted', text: 'Add:' }),
        ['mc', 'short', 'long', 'section'].map((t) =>
          h('button', { class: 'btn', type: 'button', onclick: () => (data.questions.push(newQuestion(t)), touch(), drawQuestions()) }, `+ ${TYPE_LABEL[t]}`),
        ),
      ),
    );
  }

  const statusSel = h(
    'select',
    { onchange: (e) => ((status = e.target.value), touch()) },
    ['draft', 'open', 'closed'].map((v) => h('option', { value: v, selected: v === status }, { draft: 'Draft — students can’t see it', open: 'Open — students can take it', closed: 'Closed — no new attempts' }[v])),
  );

  async function saveTest() {
    try {
      if (id === 'new') {
        const r = await api('POST', '/api/tests', { data });
        id = r.id;
        if (status !== 'draft') await api('PUT', `/api/tests/${id}`, { status });
        history.replaceState(null, '', `#edit/${id}`);
      } else {
        const r = await api('PUT', `/api/tests/${id}`, { data, status });
        data.questions.forEach((q, i) => (q.id = r.data.questions[i].id));
      }
      dirty = false;
      toast(`Saved. ${totalPoints()} points in total.`, 'ok');
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  }

  const classesInput = h('input', { value: data.classes.join(', '), placeholder: 'e.g. 10-3, 10-4 (empty = all students)' });
  classesInput.addEventListener('input', () => {
    data.classes = classesInput.value.split(',').map((c) => c.trim()).filter(Boolean);
    touch();
  });

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${data.title || 'test'}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  page(
    h(
      'div',
      { class: 'page-head' },
      h('h1', { text: id === 'new' ? 'New test' : 'Edit test' }),
      h(
        'div',
        { class: 'row' },
        id !== 'new' ? h('button', { class: 'btn', onclick: async () => (!dirty || (await saveTest())) && window.open(`/take?preview=${id}`, '_blank') }, 'Preview as student') : null,
        id !== 'new' ? h('button', { class: 'btn', onclick: exportJson }, 'Export JSON') : null,
        h('button', { class: 'btn btn-primary', onclick: saveTest }, 'Save'),
      ),
    ),
    h(
      'div',
      { class: 'card form' },
      field('Title', bind(data, 'title', h('input', { value: data.title, required: true }))),
      field('Instructions (shown at the top, can be read aloud)', bind(data, 'instructions', h('textarea', { rows: 3, value: data.instructions }))),
      h(
        'div',
        { class: 'grid-3' },
        field('Status', statusSel),
        field('Time limit (minutes, 0 = none)', bind(data, 'timeLimitMin', h('input', { type: 'number', min: 0, value: data.timeLimitMin }), Number), 'Students with extra time get more automatically.'),
        field(
          'Language (for read-aloud)',
          bind(
            data,
            'language',
            h('select', {}, [
              ['en-US', 'English (US)'],
              ['en-GB', 'English (UK)'],
              ['he-IL', 'Hebrew'],
              ['ar-SA', 'Arabic'],
              ['ru-RU', 'Russian'],
              ['fr-FR', 'French'],
              ['es-ES', 'Spanish'],
              ['de-DE', 'German'],
            ].map(([v, l]) => h('option', { value: v, selected: v === data.language }, l))),
          ),
        ),
      ),
      field('Classes', classesInput, "Must match the class you give students on the Students page."),
    ),
    h(
      'details',
      { class: 'card form', open: id === 'new' },
      h('summary', { class: 'strong', text: 'Exam mode & accommodations' }),
      h(
        'div',
        { class: 'checks' },
        h('label', { class: 'check' }, bind(s, 'requireFullscreen', h('input', { type: 'checkbox', checked: s.requireFullscreen })), 'Require full screen'),
        h('label', { class: 'check' }, bind(s, 'blockCopyPaste', h('input', { type: 'checkbox', checked: s.blockCopyPaste })), 'Block copy, paste and right-click'),
        h('label', { class: 'check' }, bind(s, 'readAloudForAll', h('input', { type: 'checkbox', checked: s.readAloudForAll })), 'Read-aloud for every student (otherwise only students you turn it on for)'),
        h('label', { class: 'check' }, bind(s, 'recordingForAll', h('input', { type: 'checkbox', checked: s.recordingForAll })), 'Voice answers for every student (otherwise only students you turn it on for)'),
      ),
      h(
        'div',
        { class: 'grid-3' },
        field('Warnings before action (0 = only log)', bind(s, 'maxViolations', h('input', { type: 'number', min: 0, max: 50, value: s.maxViolations }), Number), 'Each time a student leaves full screen or the window counts as one.'),
        field(
          'When the limit is reached',
          bind(
            s,
            'onLimit',
            h('select', {}, [
              ['lock', 'Pause the test until I unlock it'],
              ['submit', 'Submit the test automatically'],
              ['log', 'Only record it'],
            ].map(([v, l]) => h('option', { value: v, selected: v === s.onLimit }, l))),
          ),
        ),
        field(
          'After grading, students see',
          bind(
            s,
            'showResults',
            h('select', {}, [
              ['none', 'Nothing'],
              ['score', 'Their score and your feedback'],
              ['full', 'Score, feedback, their answers and the correct answers'],
            ].map(([v, l]) => h('option', { value: v, selected: v === s.showResults }, l))),
          ),
        ),
      ),
    ),
    h('h2', { text: 'Questions' }),
    qList,
    h(
      'div',
      { class: 'row end' },
      id !== 'new'
        ? h('button', {
            class: 'btn btn-ghost',
            onclick: async () => {
              const r = await api('POST', `/api/tests/${id}/duplicate`);
              location.hash = `#edit/${r.id}`;
            },
          }, 'Duplicate test')
        : null,
      id !== 'new'
        ? h('button', {
            class: 'btn btn-ghost danger',
            onclick: () =>
              modal('Delete this test?', h('p', { text: 'All student answers and recordings for it are deleted too. This cannot be undone.' }), [
                ['Cancel', null],
                [
                  'Delete',
                  async () => {
                    await api('DELETE', `/api/tests/${id}`);
                    dirty = false;
                    location.hash = '#tests';
                  },
                  'btn-danger',
                ],
              ]),
          }, 'Delete test')
        : null,
      h('button', { class: 'btn btn-primary', onclick: saveTest }, 'Save'),
    ),
  );
  drawQuestions();
  leaveGuard = () => dirty;
}

let leaveGuard = null;

// =================================================================== results

async function resultsPage(id) {
  const { test, attempts, notStarted } = await api('GET', `/api/tests/${id}/attempts`);
  const active = attempts.filter((a) => a.status === 'in_progress' || a.status === 'locked');

  const unlock = (a) => {
    const minutes = h('input', { type: 'number', min: 0, max: 240, value: 0 });
    modal(`Unlock ${a.name}'s test`, h('div', { class: 'form' }, h('p', { text: 'The student can continue where they stopped.' }), h('label', {}, 'Add extra minutes', minutes)), [
      ['Cancel', null],
      ['Unlock', async () => (await api('POST', `/api/attempts/${a.id}/unlock`, { addMinutes: minutes.value }), toast('Unlocked.', 'ok'), route()), 'btn-primary'],
    ]);
  };
  const endTest = (a) =>
    modal(`End ${a.name}'s test now?`, h('p', { text: 'Their saved answers are submitted as they are.' }), [
      ['Cancel', null],
      ['End and submit', async () => (await api('POST', `/api/attempts/${a.id}/force-submit`), route()), 'btn-danger'],
    ]);
  const allowRetake = (a) =>
    modal(`Let ${a.name} take the test again?`, h('p', { text: 'Their current attempt, answers and recordings are deleted.' }), [
      ['Cancel', null],
      ['Delete attempt', async () => (await api('DELETE', `/api/attempts/${a.id}`), route()), 'btn-danger'],
    ]);

  const statusBtn = (to, label) =>
    h('button', { class: 'btn', onclick: async () => (await api('PUT', `/api/tests/${id}`, { status: to }), route()) }, label);

  page(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', { text: test.title }), h('span', { class: `badge badge-${test.status}`, text: STATUS_LABEL[test.status] })),
      h(
        'div',
        { class: 'row' },
        test.status !== 'open' ? statusBtn('open', 'Open for students') : statusBtn('closed', 'Close test'),
        h('a', { class: 'btn', href: `#edit/${id}` }, 'Edit'),
        h('a', { class: 'btn', href: `/api/tests/${id}/export.csv` }, 'Download CSV'),
      ),
    ),
    test.status === 'open'
      ? h('p', { class: 'muted', text: `Students log in at ${location.origin} and see this test on their page.` })
      : null,
    h(
      'table',
      { class: 'table' },
      h('thead', {}, h('tr', {}, ['Student', 'Class', 'Status', 'Progress', 'Left the test', 'Score', ''].map((x) => h('th', { text: x })))),
      h(
        'tbody',
        {},
        attempts.map((a) => {
          const working = a.status === 'in_progress' || a.status === 'locked';
          const left = a.deadlineAt ? Math.max(0, (a.deadlineAt - Date.now()) / 1000) : null;
          return h(
            'tr',
            { class: a.status === 'locked' ? 'row-alert' : '' },
            h('td', {}, h('strong', { text: a.name }), h('div', { class: 'muted small', text: a.username })),
            h('td', { text: a.className }),
            h('td', {}, h('span', { class: `badge badge-${a.status}`, text: ATTEMPT_LABEL[a.status] }), a.submitReason && a.submitReason !== 'student' ? h('div', { class: 'small muted', text: { time: 'time ran out', violations: 'left too many times', teacher: 'ended by you' }[a.submitReason] }) : null),
            h('td', { text: working ? `${a.answered}/${a.questionCount}${left !== null ? ` · ${fmtDuration(left)} left` : ''}` : fmtDate(a.submittedAt) }),
            h('td', {}, a.violations ? h('span', { class: 'badge badge-warn', text: `${a.violations}×` }) : '—'),
            h('td', { text: working ? '' : `${a.score ?? 0} / ${a.maxScore}${a.toReview ? ` · ${a.toReview} to check` : ''}` }),
            h(
              'td',
              { class: 'row tight' },
              a.status === 'locked' || a.status === 'in_progress' ? null : h('a', { class: 'btn btn-primary', href: `#grade/${a.id}` }, a.status === 'returned' ? 'View' : 'Grade'),
              a.status === 'locked' ? h('button', { class: 'btn btn-primary', onclick: () => unlock(a) }, 'Unlock') : null,
              working ? h('a', { class: 'btn btn-ghost', href: `#grade/${a.id}` }, 'Log') : null,
              working ? h('button', { class: 'btn btn-ghost', onclick: () => endTest(a) }, 'End') : null,
              h('button', { class: 'btn btn-ghost', onclick: () => allowRetake(a), title: 'Delete this attempt so the student can start again' }, 'Retake'),
            ),
          );
        }),
        notStarted.map((u) => h('tr', { class: 'muted' }, h('td', { text: u.name }), h('td', { text: u.className }), h('td', { text: 'Not started' }), h('td'), h('td'), h('td'), h('td'))),
      ),
    ),
    active.length ? h('p', { class: 'small muted', text: 'This page refreshes every 10 seconds while students are working.' }) : null,
  );
  if (active.length) refreshTimer = setTimeout(() => location.hash === `#results/${id}` && route(), 10000);
}

// ==================================================================== grading

const EVENT_LABEL = {
  started: 'Started the test',
  left: 'Left the test',
  returned: 'Came back',
  fullscreen_exit: 'Left full screen',
  fullscreen_refused: 'Full screen was blocked by the browser',
  paste_blocked: 'Tried to paste',
  copy_blocked: 'Tried to copy',
  shortcut_blocked: 'Pressed a blocked shortcut',
  reopened: 'Opened the test in another window/device',
  locked: 'Test paused',
  unlocked: 'You unlocked the test',
  submitted: 'Submitted',
};

async function gradePage(attemptId) {
  const r = await api('GET', `/api/attempts/${attemptId}`);
  const { attempt, test, auto, student, events, recordings } = r;
  const grading = structuredClone(attempt.grading || {});
  const recs = Object.fromEntries(recordings.map((x) => [x.questionId, x]));
  const canGrade = attempt.status === 'submitted' || attempt.status === 'returned';
  const totalEl = h('span', { class: 'score-big' });
  const feedback = h('textarea', { rows: 4, value: attempt.feedback || '', placeholder: 'Feedback for the student (optional)' });

  const pointsOf = (q) => {
    const g = grading[q.id];
    if (g && Number.isFinite(g.points)) return g.points;
    return auto[q.id]?.auto;
  };
  const updateTotal = () => {
    const total = test.questions.reduce((s, q) => s + (q.type === 'section' ? 0 : Number(pointsOf(q)) || 0), 0);
    totalEl.textContent = `${Math.round(total * 100) / 100} / ${attempt.maxScore}`;
  };

  const answerView = (q) => {
    const a = attempt.answers[q.id];
    if (q.type === 'mc') {
      return h(
        'ol',
        { class: 'mc-review' },
        q.options.map((o, i) =>
          h('li', { class: [i === q.correct ? 'correct' : '', i === a ? 'chosen' : ''].join(' ') }, h('span', { class: 'letter', text: LETTERS[i] }), o, i === a ? ' ← chosen' : '', i === q.correct ? ' ✓' : ''),
        ),
      );
    }
    return h('div', { class: 'student-answer pre', text: a === undefined || a === '' ? '(no written answer)' : a });
  };

  let n = 0;
  const cards = test.questions.map((q) => {
    if (q.type === 'section') return h('section', { class: 'q q-section' }, q.title ? h('h3', { text: q.title }) : null, h('div', { class: 'passage', text: q.prompt }));
    const au = auto[q.id] || {};
    const g = (grading[q.id] ||= { points: null, comment: '' });
    const pts = h('input', { type: 'number', min: 0, max: q.points, step: 0.5, class: 'narrow-input', value: Number.isFinite(g.points) ? g.points : '', placeholder: au.auto ?? '?', disabled: !canGrade });
    pts.addEventListener('input', () => {
      g.points = pts.value === '' ? null : Number(pts.value);
      updateTotal();
    });
    const comment = h('input', { class: 'grow', value: g.comment || '', placeholder: 'Comment for the student', disabled: !canGrade });
    comment.addEventListener('input', () => (g.comment = comment.value));
    const needs = au.review && !Number.isFinite(g.points);
    return h(
      'section',
      { class: `q ${needs ? 'q-review' : ''}` },
      h(
        'div',
        { class: 'q-head' },
        h('span', { class: 'q-num', text: ++n }),
        h('div', { class: 'q-text' }, q.title ? h('strong', { text: q.title }) : null, h('div', { class: 'prompt', text: q.prompt })),
        needs ? h('span', { class: 'badge badge-warn', text: 'Check' }) : null,
      ),
      answerView(q),
      recs[q.id]
        ? h('div', { class: 'record-done' }, h('span', { class: 'small muted', text: `Voice answer (${fmtDuration(recs[q.id].duration || 0)})` }), h('audio', { controls: true, preload: 'metadata', src: `/api/recordings/${recs[q.id].id}` }))
        : null,
      q.type === 'short' ? h('p', { class: 'small muted', text: `Accepted: ${q.accepted.join(' · ') || '(none set)'}` }) : null,
      q.type === 'long' && q.modelAnswer ? h('details', { class: 'small' }, h('summary', { text: 'Model answer' }), h('p', { class: 'pre', text: q.modelAnswer })) : null,
      h(
        'div',
        { class: 'row grade-row' },
        h('label', { class: 'row tight' }, 'Points', pts, h('span', { class: 'muted', text: `/ ${q.points}` })),
        au.auto !== null && au.auto !== undefined ? h('span', { class: 'small muted', text: `auto: ${au.auto}` }) : h('span', { class: 'small muted', text: 'needs your mark' }),
        comment,
      ),
    );
  });

  const save = async (returnToStudent) => {
    try {
      const res = await api('PUT', `/api/attempts/${attempt.id}/grade`, { grading, feedback: feedback.value, returnToStudent });
      toast(returnToStudent ? `Returned to ${student.name}: ${res.score} / ${attempt.maxScore}` : 'Saved.', 'ok');
      if (returnToStudent) location.hash = `#results/${attempt.testId}`;
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const counted = events.filter((e) => e.counted).length;
  const timeline = h(
    'details',
    { class: 'card', open: counted > 0 },
    h('summary', { class: 'strong', text: `Activity log · left the test ${counted} time${counted === 1 ? '' : 's'}` }),
    h(
      'table',
      { class: 'table compact' },
      h('tbody', {}, events.map((e) => h('tr', { class: e.counted ? 'row-alert' : '' }, h('td', { text: fmtTime(e.at) }), h('td', { text: EVENT_LABEL[e.type] || e.type }), h('td', { class: 'muted', text: e.detail })))),
    ),
  );

  page(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('a', { href: `#results/${attempt.testId}`, text: `← ${test.title}` }),
        h('h1', { text: student.name }),
        h(
          'p',
          { class: 'muted' },
          `${student.className || 'No class'} · started ${fmtDate(attempt.startedAt)}`,
          attempt.submittedAt ? ` · submitted ${fmtDate(attempt.submittedAt)}` : ' · still working',
          student.readAloud ? ' · read-aloud' : '',
          student.voiceAnswers ? ' · voice answers' : '',
          student.extraTimePct ? ` · +${student.extraTimePct}% time` : '',
        ),
      ),
      totalEl,
    ),
    timeline,
    h('div', { dir: isRtl(test.language) ? 'rtl' : 'ltr' }, cards),
    canGrade
      ? h(
          'div',
          { class: 'card form sticky-bottom' },
          h('label', {}, 'Overall feedback', feedback),
          h(
            'div',
            { class: 'row end' },
            h('button', { class: 'btn', onclick: () => save(false) }, 'Save'),
            h('button', { class: 'btn btn-primary', onclick: () => save(true) }, attempt.status === 'returned' ? 'Save & update student' : 'Save & return to student'),
          ),
        )
      : h('p', { class: 'muted', text: 'The student is still working. You can grade after they submit.' }),
  );
  updateTotal();
}

// ==================================================================== people

function credentialsSheet(created) {
  const sheet = h(
    'div',
    { class: 'credentials' },
    created.map((c) =>
      h('div', { class: 'cred' }, h('strong', { text: c.name }), c.className ? h('span', { class: 'muted', text: ` · ${c.className}` }) : null, h('div', {}, 'Site: ', h('code', { text: location.origin })), h('div', {}, 'Username: ', h('code', { text: c.username })), h('div', {}, 'Password: ', h('code', { text: c.password }))),
    ),
  );
  modal('Login details', h('div', {}, h('p', { class: 'strong', text: 'Print or copy these now. Passwords are not shown again (you can reset them later).' }), sheet), [
    ['Print', () => (document.body.classList.add('printing-creds'), window.print(), document.body.classList.remove('printing-creds'), false)],
    ['Done', () => route(), 'btn-primary'],
  ]);
}

async function peoplePage() {
  const { users } = await api('GET', '/api/users');
  const students = users.filter((u) => u.role === 'student');
  const teachers = users.filter((u) => u.role === 'teacher');
  const classes = [...new Set(students.map((s) => s.className).filter(Boolean))].sort();
  let filter = '';
  try {
    filter = sessionStorage.getItem('classFilter') || '';
  } catch {}

  const bulk = h('textarea', { rows: 6, placeholder: 'Dana Levi, 10-3\nYoni Cohen, 10-3\nNoa Mizrahi, 10-4' });
  const addStudents = async () => {
    const people = bulk.value
      .split('\n')
      .map((line) => line.split(/[,\t]/).map((x) => x.trim()))
      .filter(([name]) => name)
      .map(([name, className]) => ({ name, className }));
    if (!people.length) return toast('Write one student per line: name, class', 'warn');
    const { created } = await api('POST', '/api/users/bulk', { people });
    credentialsSheet(created);
  };

  const update = async (u, patch) => {
    try {
      await api('PUT', `/api/users/${u.id}`, patch);
      Object.assign(u, patch);
      toast('Saved.', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const tbody = h('tbody');
  const draw = () =>
    clear(
      tbody,
      students
        .filter((s) => !filter || s.className === filter)
        .map((s) => {
          const className = h('input', { value: s.className, class: 'narrow-input' });
          className.addEventListener('change', () => update(s, { className: className.value }));
          return h(
            'tr',
            {},
            h('td', {}, h('strong', { text: s.name })),
            h('td', {}, h('code', { text: s.username })),
            h('td', {}, className),
            h('td', {}, h('input', { type: 'checkbox', checked: s.readAloud, 'aria-label': 'Read-aloud', onchange: (e) => update(s, { readAloud: e.target.checked }) })),
            h('td', {}, h('input', { type: 'checkbox', checked: s.voiceAnswers, 'aria-label': 'Voice answers', onchange: (e) => update(s, { voiceAnswers: e.target.checked }) })),
            h(
              'td',
              {},
              h('select', { 'aria-label': 'Extra time', onchange: (e) => update(s, { extraTimePct: Number(e.target.value) }) }, [0, 25, 33, 50, 100].map((p) => h('option', { value: p, selected: p === s.extraTimePct }, p ? `+${p}%` : 'none'))),
            ),
            h(
              'td',
              { class: 'row tight' },
              h('button', {
                class: 'btn btn-ghost',
                onclick: async () => {
                  const r = await api('POST', `/api/users/${s.id}/reset-password`);
                  credentialsSheet([{ name: s.name, className: s.className, username: r.username, password: r.password }]);
                },
              }, 'Reset password'),
              h('button', {
                class: 'btn btn-ghost danger',
                onclick: () =>
                  modal(`Delete ${s.name}?`, h('p', { text: 'Their test answers and recordings are deleted too.' }), [
                    ['Cancel', null],
                    ['Delete', async () => (await api('DELETE', `/api/users/${s.id}`), route()), 'btn-danger'],
                  ]),
              }, 'Delete'),
            ),
          );
        }),
    );

  const filterSel = h(
    'select',
    {
      onchange: (e) => {
        filter = e.target.value;
        try {
          sessionStorage.setItem('classFilter', filter);
        } catch {}
        draw();
      },
    },
    h('option', { value: '' }, 'All classes'),
    classes.map((c) => h('option', { value: c, selected: c === filter }, c)),
  );

  const teacherName = h('input', { placeholder: 'Name' });
  page(
    h('div', { class: 'page-head' }, h('h1', { text: 'Students' }), filterSel),
    h(
      'table',
      { class: 'table' },
      h('thead', {}, h('tr', {}, ['Name', 'Username', 'Class', 'Read-aloud', 'Voice answers', 'Extra time', ''].map((x) => h('th', { text: x })))),
      tbody,
    ),
    h(
      'div',
      { class: 'card form' },
      h('h2', { text: 'Add students' }),
      h('label', {}, 'One per line: name, class', bulk),
      h('div', { class: 'row end' }, h('button', { class: 'btn btn-primary', onclick: addStudents }, 'Create accounts')),
    ),
    h(
      'details',
      { class: 'card form' },
      h('summary', { class: 'strong', text: `Teachers (${teachers.length})` }),
      h('p', { class: 'muted', text: 'Every teacher account can see and grade all tests and students.' }),
      h('ul', {}, teachers.map((t) => h('li', {}, `${t.name} `, h('code', { text: t.username })))),
      h(
        'div',
        { class: 'row' },
        teacherName,
        h('button', {
          class: 'btn',
          onclick: async () => {
            if (!teacherName.value.trim()) return;
            const { created } = await api('POST', '/api/users/bulk', { role: 'teacher', people: [{ name: teacherName.value }] });
            credentialsSheet(created);
          },
        }, 'Add teacher'),
      ),
    ),
  );
  draw();
}

// ==================================================================== router

let currentHash = null;
async function route() {
  clearTimeout(refreshTimer);
  const hash = location.hash || '#tests';
  currentHash = hash;
  const [name, arg] = hash.slice(1).split('/');
  try {
    if (name === 'edit') await editorPage(arg);
    else if (name === 'results') await resultsPage(arg);
    else if (name === 'grade') await gradePage(arg);
    else if (name === 'people') await peoplePage();
    else await testsPage();
  } catch (e) {
    page(h('p', { class: 'error', text: e.message }));
  }
}

window.addEventListener('hashchange', () => {
  if (leaveGuard?.() && !confirm('You have unsaved changes. Leave anyway?')) {
    history.replaceState(null, '', currentHash);
    return;
  }
  leaveGuard = null;
  route();
});
window.addEventListener('beforeunload', (e) => {
  if (leaveGuard?.()) e.preventDefault();
});

(async () => {
  user = await requireUser('teacher');
  route();
})();
