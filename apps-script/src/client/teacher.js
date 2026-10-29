// The teacher's pages: tests, editor, live results, grading, students.

(function () {
const app = document.getElementById('app');
let refreshTimer = null;

const NAV = [['Tests', '#tests'], ['Classes', '#classes']].concat(BOOT.user.admin ? [['Teachers', '#teachers'], ['Settings', '#settings']] : []);

function page(...children) {
  clear(app, header(NAV), h('main', { class: 'wrap' }, children));
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
        h('button', { class: 'btn', onclick: () => App.aiImport() }, '✨ Create from PDF/Word with AI'),
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
                h('td', {}, t.classes.join(', ') || 'All my classes', t.ownerId && t.ownerId !== BOOT.user.id ? h('div', { class: 'muted small', text: `by ${t.ownerId}` }) : null),
                h('td', { text: t.active || '' }),
                h('td', {}, t.toGrade ? h('span', { class: 'badge badge-warn', text: t.toGrade }) : ''),
                h('td', { text: t.returned || '' }),
                h('td', {}, h('div', { class: 'row tight' }, h('a', { class: 'btn btn-ghost', href: App.previewHash(t.id, { back: '#tests' }), title: 'See the test exactly as students do' }, '👁 Student view'), h('a', { class: 'btn btn-ghost', href: `#edit/${t.id}` }, 'Edit'), h('a', { class: 'btn btn-ghost', href: `#results/${t.id}` }, 'Results')),
              )),
            ),
          ),
        )
      : h(
          'div',
          { class: 'card' },
          h('p', { text: 'No tests yet. Create one, or import the sample test (samples folder in the GitHub repo).' }),
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
      voice: { provider: 'browser', name: '' },
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
  if (type === 'blanks') {
    q.title = 'Complete the sentences.';
    q.wordBank = [];
    q.dropdown = false;
  }
  if (type === 'match') {
    q.prompt = 'Match each word to its meaning.';
    q.pairs = [{ left: '', right: '' }, { left: '', right: '' }];
    q.extra = [];
    q.points = 2;
  }
  if (type === 'vocab') {
    q.prompt = 'Match the items to the definitions. Write the number of the item next to its definition.';
    q.items = ['', '', '', '', '', ''];
    q.pairs = [{ text: '', answer: 0 }, { text: '', answer: 1 }, { text: '', answer: 2 }];
    q.pointsEach = 2;
  }
  return q;
}

const TYPE_LABEL = {
  section: 'Text / reading passage',
  mc: 'Multiple choice',
  short: 'Short answer (auto-marked)',
  blanks: 'Fill in the blanks',
  match: 'Matching',
  vocab: 'Module E vocabulary (numbered items)',
  long: 'Open answer (you mark it)',
};
const countBlanks = (text) => (String(text || '').match(/\{[^{}]*\}/g) || []).length;

// Natural voices a teacher can pick from (any other Google voice name works too).
const GOOGLE_VOICES = [
  ['en-US-Chirp3-HD-Aoede', 'US English, woman (most natural)'],
  ['en-US-Chirp3-HD-Charon', 'US English, man (most natural)'],
  ['en-US-Neural2-F', 'US English, woman'],
  ['en-US-Neural2-D', 'US English, man'],
  ['en-GB-Neural2-A', 'British English, woman'],
  ['en-GB-Neural2-B', 'British English, man'],
  ['he-IL-Wavenet-A', 'Hebrew, woman'],
  ['he-IL-Wavenet-B', 'Hebrew, man'],
];

async function editorPage(id) {
  let status = 'draft';
  let data;
  let ownerId = BOOT.user.id;
  if (id === 'new') data = blankTest();
  else {
    const r = await api('GET', `/api/tests/${id}`);
    data = r.data;
    status = r.status;
    ownerId = r.ownerId;
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

  // Items on the left (numbered), definitions on the right, each with the
  // number of its correct item. More items than definitions = distractors.
  function vocabEditor(q) {
    const box = h('div', { class: 'vocab-editor' });
    const draw = () => {
      const items = h('textarea', { rows: Math.max(4, q.items.length + 1), value: q.items.join('\n'), placeholder: 'a calendar\na season\nan island\ntraffic\na prize\na label' });
      items.addEventListener('input', () => {
        q.items = items.value.split('\n').map((x) => x.trim());
        touch();
      });
      items.addEventListener('change', () => {
        q.items = q.items.filter(Boolean);
        q.pairs.forEach((p) => (p.answer = Math.min(p.answer, Math.max(0, q.items.length - 1))));
        draw();
      });
      const rows = q.pairs.map((p, k) =>
        h(
          'div',
          { class: 'row tight' },
          h(
            'select',
            { 'aria-label': 'Correct item', onchange: (e) => ((p.answer = Number(e.target.value)), touch()) },
            q.items.filter(Boolean).map((it, i) => h('option', { value: i, selected: p.answer === i }, `${i + 1}. ${it}`)),
          ),
          bind(p, 'text', h('input', { value: p.text, class: 'grow', placeholder: 'Definition, e.g. "shows days, weeks, and months in a year"' })),
          q.pairs.length > 1 ? h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': 'Remove definition', onclick: () => (q.pairs.splice(k, 1), touch(), draw()) }, '✕') : null,
        ),
      );
      clear(
        box,
        h('label', {}, h('span', { text: 'Items, one per line (students see them numbered 1, 2, 3…)' }), items),
        h('span', { class: 'small muted', text: 'Definitions: pick the correct item for each. Items not used are distractors.' }),
        rows,
        q.pairs.length < 20 ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => (q.pairs.push({ text: '', answer: 0 }), touch(), draw()) }, '+ Definition') : null,
      );
    };
    draw();
    return box;
  }

  function questionEditor(q, index) {
    const move = (d) => {
      const j = index + d;
      if (j < 0 || j >= data.questions.length) return;
      [data.questions[index], data.questions[j]] = [data.questions[j], data.questions[index]];
      touch();
      drawQuestions();
    };
    const body = h('div', { class: 'form' });
    const pointsRow = (hint) =>
      h('div', { class: 'row' }, field('Points', bind(q, 'points', h('input', { type: 'number', min: 0, step: 0.5, value: q.points, class: 'narrow-input' }), Number), hint));
    if (q.type === 'section') {
      body.append(
        field('Heading (optional)', bind(q, 'title', h('input', { value: q.title }))),
        field('Text students read (instructions, a story, a passage…)', bind(q, 'prompt', h('textarea', { rows: 5, value: q.prompt }))),
      );
    } else if (q.type === 'blanks') {
      const count = h('small', { class: 'muted' });
      const text = h('textarea', { rows: 5, value: q.prompt, dir: 'auto', placeholder: 'She opened a small {business} selling jewelry online.\nIt is fun {to play|playing} video games.' });
      const showCount = () => {
        const n = countBlanks(text.value);
        count.textContent = n ? `${n} blank${n === 1 ? '' : 's'} · each is worth an equal share of the points` : 'No blanks yet: put each answer in {curly braces}.';
      };
      text.addEventListener('input', () => ((q.prompt = text.value), touch(), showCount()));
      showCount();
      const bank = h('textarea', { rows: 2, value: (q.wordBank || []).join('\n'), dir: 'auto', placeholder: 'business\norganization\ngrowing concern' });
      bank.addEventListener('input', () => {
        q.wordBank = bank.value.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
        touch();
      });
      body.append(
        field('Instruction', bind(q, 'title', h('input', { value: q.title, dir: 'auto' }))),
        h(
          'label',
          {},
          h('span', { text: 'Text with the answers in {curly braces}' }),
          text,
          h('small', { class: 'muted', text: 'Each {…} becomes a blank. Several right answers: {to play|playing}. Empty {} = a blank you mark yourself. One sentence per line.' }),
          count,
        ),
        field('Word bank (optional, one per line)', bank, 'Shown above the sentences. Words are crossed out as students use them.'),
        h('label', { class: 'check' }, bind(q, 'dropdown', h('input', { type: 'checkbox', checked: !!q.dropdown })), 'Students choose from the word bank in a drop-down instead of typing'),
        pointsRow(),
      );
    } else if (q.type === 'match') {
      const rows = h('div', { class: 'match-editor' });
      const drawPairs = () =>
        clear(
          rows,
          h('div', { class: 'row tight small muted' }, h('span', { class: 'grow', text: 'Item' }), h('span', { class: 'grow', text: 'Its match' })),
          q.pairs.map((p, i) =>
            h(
              'div',
              { class: 'row tight' },
              h('span', { class: 'letter', text: i + 1 }),
              bind(p, 'left', h('input', { value: p.left, class: 'grow', dir: 'auto', placeholder: 'Unique' })),
              '→',
              bind(p, 'right', h('input', { value: p.right, class: 'grow', dir: 'auto', placeholder: 'special' })),
              q.pairs.length > 2
                ? h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': 'Remove pair', onclick: () => (q.pairs.splice(i, 1), touch(), drawPairs()) }, '✕')
                : null,
            ),
          ),
          q.pairs.length < 40 ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => (q.pairs.push({ left: '', right: '' }), touch(), drawPairs()) }, '+ Pair') : null,
        );
      drawPairs();
      const extra = h('textarea', { rows: 2, value: (q.extra || []).join('\n'), dir: 'auto', placeholder: 'to sing' });
      extra.addEventListener('input', () => {
        q.extra = extra.value.split('\n').map((x) => x.trim()).filter(Boolean);
        touch();
      });
      body.append(
        field('Instruction', bind(q, 'prompt', h('textarea', { rows: 2, value: q.prompt, dir: 'auto' }))),
        h('div', {}, h('span', { class: 'small muted', text: 'Pairs: students see the matches mixed up and choose one for each item.' }), rows),
        field('Extra wrong choices (optional, one per line)', extra),
        pointsRow('Each pair is worth an equal share.'),
      );
    } else if (q.type === 'vocab') {
      body.append(
        field('Instructions', bind(q, 'prompt', h('textarea', { rows: 2, value: q.prompt }))),
        h('div', { class: 'row' }, field('Points for each correct match', bind(q, 'pointsEach', h('input', { type: 'number', min: 0, step: 0.5, value: q.pointsEach, class: 'narrow-input' }), Number))),
        vocabEditor(q),
      );
    } else {
      body.append(
        field('Question', bind(q, 'prompt', h('textarea', { rows: 2, value: q.prompt }))),
        h('div', { class: 'row' }, field('Points', bind(q, 'points', h('input', { type: 'number', min: 0, step: 0.5, value: q.points, class: 'narrow-input' }), Number))),
      );
    }
    if (q.type === 'mc') {
      const opts = h('div', { class: 'mc-options' });
      const multi = h('input', { type: 'checkbox', checked: !!q.multiple });
      multi.addEventListener('change', () => {
        q.multiple = multi.checked;
        q.correct = q.multiple ? asList(q.correct) : asList(q.correct)[0] ?? 0;
        if (q.multiple && !q.scoring) q.scoring = 'partial';
        touch();
        drawOpts();
      });
      const isCorrect = (i) => asList(q.correct).includes(i);
      const toggleCorrect = (i, on) => {
        const set = new Set(asList(q.correct));
        on ? set.add(i) : set.delete(i);
        q.correct = [...set].sort((a, b) => a - b);
        touch();
      };
      const drawOpts = () => {
        clear(
          opts,
          h('label', { class: 'check' }, multi, 'More than one correct answer (e.g. "Choose the TWO correct answers")'),
          q.multiple
            ? h(
                'label',
                { class: 'row tight' },
                'Marking:',
                bind(q, 'scoring', h('select', {}, [['partial', 'Points for each correct answer chosen'], ['all', 'All correct, or no points']].map(([v, l]) => h('option', { value: v, selected: (q.scoring || 'partial') === v }, l)))),
              )
            : null,
          h('span', { class: 'small muted', text: q.multiple ? 'Options — tick every correct one. Students are told how many to choose.' : 'Options — select the correct one' }),
          q.options.map((o, i) =>
            h(
              'div',
              { class: 'row tight' },
              q.multiple
                ? h('input', { type: 'checkbox', checked: isCorrect(i), 'aria-label': `Option ${LETTERS[i]} is correct`, onchange: (e) => toggleCorrect(i, e.target.checked) })
                : h('input', {
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
                      if (q.multiple) q.correct = asList(q.correct).filter((c) => c !== i).map((c) => (c > i ? c - 1 : c));
                      else if (q.correct >= q.options.length) q.correct = 0;
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
    return data.questions.reduce((sum, q) => sum + (q.type === 'section' ? 0 : q.type === 'vocab' ? (Number(q.pointsEach) || 0) * q.pairs.length : Number(q.points) || 0), 0);
  }

  function drawQuestions() {
    clear(
      qList,
      data.questions.map((q, i) => questionEditor(q, i)),
      h(
        'div',
        { class: 'card add-row' },
        h('span', { class: 'muted', text: 'Add:' }),
        ['mc', 'short', 'blanks', 'match', 'vocab', 'long', 'section'].map((t) =>
          h('button', { class: 'btn', type: 'button', onclick: () => (data.questions.push(newQuestion(t)), touch(), drawQuestions()) }, `+ ${TYPE_LABEL[t]}`),
        ),
      ),
    );
  }

  // Read-aloud voice for this test: the device's own voice (free, no setup),
  // or a natural voice whose audio is prepared once and saved in Drive.
  function voicePanel() {
    s.voice ||= { provider: 'browser', name: '' };
    const v = s.voice;
    const box = h('div', { class: 'form' });
    const status = h('p', { class: 'small' });
    const player = h('div');
    const nameList = h('datalist', { id: 'google-voices' }, GOOGLE_VOICES.map(([n, l]) => h('option', { value: n }, l)));

    async function refreshStatus() {
      if (v.provider === 'browser') return clear(status);
      if (id === 'new' || dirty) return clear(status, 'Save the test, then press Prepare audio.');
      try {
        const st = await api('GET', `/api/tests/${id}/audio`);
        status.textContent = st.missing
          ? `${st.ready} of ${st.total} pieces have audio. Until all are ready, the rest is read by the device voice.`
          : `All ${st.total} pieces have natural-voice audio. ✓`;
      } catch (e) {
        status.textContent = e.message;
      }
    }

    async function prepare(btn) {
      if ((id === 'new' || dirty) && !(await saveTest())) return;
      btn.disabled = true;
      try {
        for (;;) {
          status.textContent = 'Making audio… keep this page open.';
          const st = await api('POST', `/api/tests/${id}/audio`);
          status.textContent = `Making audio… ${st.ready} of ${st.total} ready.`;
          if (!st.missing) break;
        }
        await refreshStatus();
        toast('Audio ready.', 'ok');
      } catch (e) {
        status.textContent = e.message;
        toast(e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    }

    async function tryVoice(btn) {
      btn.disabled = true;
      clear(player, h('span', { class: 'small muted', text: 'Making a sample…' }));
      try {
        const first = data.questions.find((q) => q.type !== 'section' && q.prompt);
        const text = first ? first.prompt.replace(/\{[^{}]*\}/g, '…').slice(0, 250) : '';
        const a = await api('POST', '/api/voices/try', { provider: v.provider, name: v.name, language: data.language, text });
        const audio = h('audio', { controls: true, autoplay: true, src: `data:${a.mime};base64,${a.data}` });
        clear(player, audio);
      } catch (e) {
        clear(player, h('p', { class: 'error small', text: e.message }));
      } finally {
        btn.disabled = false;
      }
    }

    const draw = () => {
      const help = {
        browser: 'Free and needs no setup. Each Chromebook or computer uses its own built-in voice, so it may sound robotic.',
        google: 'Natural Google voices. Needs a Google Cloud key under Students → Settings. Audio is made once per test and saved in your Drive.',
        chatterbox: 'Your own Chatterbox voice server. Needs its address under Students → Settings, and the server must be running while you press Prepare audio (not during the test).',
      }[v.provider];
      clear(
        box,
        h(
          'div',
          { class: 'grid-3' },
          field(
            'Voice',
            h(
              'select',
              {
                onchange: (e) => {
                  v.provider = e.target.value;
                  touch();
                  draw();
                },
              },
              [
                ['browser', 'Device voice (free, no setup)'],
                ['google', 'Google natural voice'],
                ['chatterbox', 'Chatterbox (your own server)'],
              ].map(([val, l]) => h('option', { value: val, selected: v.provider === val }, l)),
            ),
          ),
          v.provider === 'browser'
            ? null
            : field(
                v.provider === 'google' ? 'Voice name' : 'Voice name (optional)',
                bind(v, 'name', h('input', { value: v.name, list: v.provider === 'google' ? 'google-voices' : null, placeholder: v.provider === 'google' ? 'en-US-Chirp3-HD-Aoede' : 'as set up on your server' })),
                v.provider === 'google' ? 'Pick from the list or type any Google voice name.' : null,
              ),
        ),
        h('p', { class: 'small muted', text: help }),
        v.provider === 'browser'
          ? null
          : h(
              'div',
              { class: 'row' },
              h('button', { class: 'btn', type: 'button', onclick: (e) => tryVoice(e.currentTarget) }, '▶ Try voice'),
              h('button', { class: 'btn btn-primary', type: 'button', onclick: (e) => prepare(e.currentTarget) }, '🔊 Prepare audio'),
            ),
        player,
        status,
        nameList,
      );
      refreshStatus();
    };
    draw();
    return h('details', { class: 'card form', open: v.provider !== 'browser' }, h('summary', { class: 'strong', text: 'Read-aloud voice' }), box);
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

  // Tick the classes the test is for; none ticked = all of the owner's classes.
  data.classIds = data.classIds || [];
  const classesBox = h('div', { class: 'class-picks' }, h('span', { class: 'muted', text: 'Loading classes…' }));
  api('GET', '/api/classes').then(({ classes }) => {
    const theirs = classes.filter((c) => c.ownerId === ownerId);
    if (!theirs.length) return clear(classesBox, h('span', { class: 'muted' }, 'No classes yet. ', h('a', { href: '#classes' }, 'Create a class'), ' first.'));
    clear(
      classesBox,
      theirs.map((c) =>
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: data.classIds.includes(c.id),
            onchange: (e) => {
              data.classIds = e.target.checked ? [...new Set([...data.classIds, c.id])] : data.classIds.filter((x) => x !== c.id);
              touch();
            },
          }),
          `${c.name} (${c.students.filter((x) => x.status === 'active').length} students)`,
        ),
      ),
    );
  }).catch((e) => clear(classesBox, h('span', { class: 'error', text: e.message })));

  // Downloads are unreliable inside Google's frame, so show the JSON to copy.
  const exportJson = () => {
    const ta = h('textarea', { rows: 14, readonly: true, value: JSON.stringify(data, null, 2) });
    modal('Test as JSON', h('div', {}, h('p', { class: 'muted', text: 'Copy this into a .json file to keep a backup or share the test with another teacher.' }), ta), [
      ['Copy', () => (ta.select(), document.execCommand('copy'), toast('Copied.', 'ok'), false)],
      ['Close', null, 'btn-primary'],
    ]);
  };

  page(
    h(
      'div',
      { class: 'page-head' },
      h('h1', { text: id === 'new' ? 'New test' : 'Edit test' }),
      h(
        'div',
        { class: 'row' },
        id !== 'new' ? h('button', { class: 'btn', onclick: async () => { if (!dirty || (await saveTest())) location.hash = App.previewHash(id, { back: `#edit/${id}` }); } }, '👁 Student view') : null,
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
      h('div', {}, h('span', { class: 'strong', text: 'Classes' }), h('small', { class: 'muted', text: ' — none ticked = all your classes' }), classesBox),
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
    voicePanel(),
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
        h('a', { class: 'btn', href: App.previewHash(id, { back: `#results/${id}` }) }, '👁 Student view'),
        h('a', { class: 'btn', href: `#edit/${id}` }, 'Edit'),
        h('button', {
          class: 'btn',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const { url } = await api('POST', `/api/tests/${id}/export`);
              modal('Results copied to Google Sheets', h('p', {}, h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open the results sheet')));
            } catch (err) {
              toast(err.message, 'error');
            }
            e.target.disabled = false;
          },
        }, 'Results to Google Sheets'),
      ),
    ),
    test.status === 'open'
      ? h('p', { class: 'muted', text: 'Students open the app link (the same link you use) and see this test on their page.' })
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
            h('td', {}, h('strong', { text: a.name }), h('div', { class: 'muted small', text: a.email })),
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
    active.length ? h('p', { class: 'small muted', text: 'This page refreshes every 20 seconds while students are working.' }) : null,
  );
  if (active.length) refreshTimer = setTimeout(() => location.hash === `#results/${id}` && route(), 20000);
}

// ==================================================================== grading

const EVENT_LABEL = {
  started: 'Started the test',
  left: 'Left the test',
  returned: 'Came back',
  fullscreen_exit: 'Left full screen',
  fullscreen_refused: 'Full screen is not available (test continued without it)',
  paste_blocked: 'Tried to paste',
  copy_blocked: 'Tried to copy',
  shortcut_blocked: 'Pressed a blocked shortcut',
  reopened: 'Opened the test in another window/device',
  recorder_opened: 'Opened the voice recorder',
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
    if (q.type === 'blanks') return blanksReview(q, a);
    if (q.type === 'match') return matchReview(q, a);
    if (q.type === 'mc') {
      const chosen = asList(a);
      const right = asList(q.correct);
      return h(
        'ol',
        { class: 'mc-review' },
        q.multiple ? h('li', { class: 'muted small', text: `Choose ${right.length} · ${q.scoring === 'all' ? 'all or nothing' : 'points for each correct answer'}` }) : null,
        q.options.map((o, i) =>
          h(
            'li',
            { class: [right.includes(i) ? 'correct' : '', chosen.includes(i) ? 'chosen' : ''].join(' ') },
            h('span', { class: 'letter', text: LETTERS[i] }),
            o,
            chosen.includes(i) ? ' ← chosen' : '',
            right.includes(i) ? ' ✓' : '',
          ),
        ),
      );
    }
    if (q.type === 'vocab') {
      const picks = Array.isArray(a) ? a : [];
      return h(
        'ol',
        { class: 'mc-review' },
        q.pairs.map((p, k) => {
          const got = picks[k];
          const ok = got === p.answer;
          return h(
            'li',
            { class: ok ? 'correct' : got === null || got === undefined ? '' : 'chosen' },
            h('span', { class: 'letter', text: got === null || got === undefined ? '–' : got + 1 }),
            p.text,
            ok ? ' ✓' : ` (correct: ${p.answer + 1}. ${q.items[p.answer]})`,
          );
        }),
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
        h(
          'div',
          { class: 'q-text' },
          q.title ? h('strong', { dir: 'auto', text: q.title }) : null,
          h('div', { class: 'prompt', dir: 'auto', text: q.type === 'blanks' ? q.prompt.replace(/\{[^{}]*\}/g, '_____') : q.prompt }),
        ),
        needs ? h('span', { class: 'badge badge-warn', text: 'Check' }) : null,
      ),
      answerView(q),
      recs[q.id] ? recordingPlayer(recs[q.id].id, `Play voice answer (${fmtDuration(recs[q.id].duration || 0)})`) : null,
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

// Fill in the blanks for marking: each blank with the student's answer and
// the accepted ones.
function blanksReview(q, a) {
  const keys = [];
  q.prompt.replace(/\{([^{}]*)\}/g, (_, inner) => keys.push(inner.split('|').map((x) => x.trim()).filter(Boolean)));
  const given = Array.isArray(a) ? a : [];
  const norm = (x) => String(x || '').trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[.!]+$/, '');
  return h(
    'table',
    { class: 'table compact' },
    h('thead', {}, h('tr', {}, h('th', { text: '#' }), h('th', { text: 'Student wrote' }), h('th', { text: 'Accepted' }), h('th', {}))),
    h(
      'tbody',
      {},
      keys.map((acc, i) => {
        const g = given[i] || '';
        const ok = acc.some((x) => norm(x) === norm(g));
        return h(
          'tr',
          { class: ok ? '' : g.trim() ? 'row-alert' : '' },
          h('td', { text: i + 1 }),
          h('td', { dir: 'auto', text: g || '—' }),
          h('td', { dir: 'auto', class: 'muted', text: acc.join(' · ') || '(you mark it)' }),
          h('td', { text: ok ? '✓' : g.trim() ? '✗' : '' }),
        );
      }),
    ),
  );
}

function matchReview(q, a) {
  const given = Array.isArray(a) ? a : [];
  return h(
    'table',
    { class: 'table compact' },
    h('thead', {}, h('tr', {}, h('th', { text: 'Item' }), h('th', { text: 'Student chose' }), h('th', { text: 'Correct' }), h('th', {}))),
    h(
      'tbody',
      {},
      q.pairs.map((p, i) => {
        const ok = given[i] === p.right;
        return h('tr', { class: ok || !given[i] ? '' : 'row-alert' }, h('td', { dir: 'auto', text: p.left }), h('td', { dir: 'auto', text: given[i] || '—' }), h('td', { dir: 'auto', class: 'muted', text: p.right }), h('td', { text: ok ? '✓' : given[i] ? '✗' : '' }));
      }),
    ),
  );
}

// =================================================================== classes

const JOIN_MODES = [
  ['off', 'Off'],
  ['open', 'On — anyone with the code joins'],
  ['approve', 'On — I approve each student'],
];

function parseLines(text) {
  return text
    .split('\n')
    .map((line) => line.split(/[,\t;]/).map((x) => x.trim()))
    .filter(([email]) => email)
    .map(([email, name]) => ({ email, name }));
}

async function classesPage() {
  App.studentsCache = null; // the student view's "As:" list reloads after changes
  const { classes, classroomAvailable, classroomNeedsSetup } = await api('GET', '/api/classes');
  let courses = null;
  const loadCourses = async () => (courses ||= (await api('GET', '/api/classroom/courses')).courses);

  const update = async (s, patch) => {
    try {
      await api('PUT', `/api/students/${encodeURIComponent(s.id)}`, patch);
      Object.assign(s, patch);
      toast('Saved.', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const act = async (fn, okMessage) => {
    try {
      const r = await fn();
      if (okMessage) toast(typeof okMessage === 'function' ? okMessage(r) : okMessage, 'ok');
      if (r && r.skipped && r.skipped.length) modal('Some students were skipped', h('ul', {}, r.skipped.map((x) => h('li', { text: x }))));
      route();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  function classCard(c) {
    const pending = c.students.filter((s) => s.status === 'pending');
    const active = c.students.filter((s) => s.status === 'active');
    const name = h('input', { value: c.name, class: 'class-name', 'aria-label': 'Class name' });
    name.addEventListener('change', () => act(() => api('PUT', `/api/classes/${c.id}`, { name: name.value }), 'Renamed.'));

    const joinMode = h(
      'select',
      { 'aria-label': 'Joining with the code', onchange: (e) => act(() => api('PUT', `/api/classes/${c.id}`, { joinMode: e.target.value }), 'Saved.') },
      JOIN_MODES.map(([v, l]) => h('option', { value: v, selected: c.joinMode === v }, l)),
    );
    const join = h(
      'div',
      { class: 'join-box' },
      h('div', {}, h('div', { class: 'small muted', text: 'Class code' }), h('div', { class: `join-code ${c.joinMode === 'off' ? 'off' : ''}`, text: c.joinCode })),
      h(
        'div',
        { class: 'grow' },
        h('label', { class: 'row tight' }, 'Joining:', joinMode),
        h('p', { class: 'small muted', text: c.joinMode === 'off' ? 'Turn joining on, then tell students to open the app link and type the code.' : 'Students open the app link and type this code. Turn joining off when everyone is in.' }),
      ),
      h('button', { class: 'btn btn-ghost', onclick: () => act(() => api('PUT', `/api/classes/${c.id}`, { newCode: true }), 'New code made. The old one no longer works.') }, 'New code'),
    );

    const bulk = h('textarea', { rows: 3, placeholder: 'dana.levi@school.org, Dana Levi\nyoni.cohen@school.org, Yoni Cohen' });
    const addByEmail = h(
      'details',
      {},
      h('summary', { text: 'Add students by email' }),
      h('p', { class: 'small muted', text: 'One per line: school email, name. Useful for one student who can’t use the code.' }),
      bulk,
      h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => {
        const people = parseLines(bulk.value);
        if (!people.length) return toast('Write one student per line: email, name', 'warn');
        act(() => api('POST', `/api/classes/${c.id}/students`, { people }), (r) => `Added ${r.added} student${r.added === 1 ? '' : 's'}.`);
      } }, 'Add')),
    );

    let classroom = null;
    if (classroomAvailable) {
      const pick = h('select', { 'aria-label': 'Classroom class' }, h('option', { value: '' }, c.classroomId ? 'Linked Classroom class' : 'Choose a Classroom class…'));
      const loadBtn = h('button', { class: 'btn', onclick: async () => {
        if (!pick.value && !c.classroomId) {
          try {
            const list = await loadCourses();
            clear(pick, h('option', { value: '' }, 'Choose a Classroom class…'), list.map((x) => h('option', { value: x.id, selected: x.id === c.classroomId }, `${x.name}${x.section ? ` (${x.section})` : ''}`)));
            if (!list.length) toast('No active Google Classroom classes found for your account.', 'warn');
            loadBtn.textContent = 'Import students';
            return;
          } catch (e) {
            return toast(e.message, 'error');
          }
        }
        act(() => api('POST', `/api/classes/${c.id}/classroom`, { courseId: pick.value }), (r) => `Imported ${r.added} of ${r.total} students from Classroom.`);
      } }, c.classroomId ? 'Sync from Classroom again' : 'Load my Classroom classes');
      classroom = h('div', { class: 'row tight' }, h('span', { class: 'small muted', text: 'Google Classroom:' }), c.classroomId ? null : pick, loadBtn);
    }

    const studentRow = (s) =>
      h(
        'tr',
        { class: s.status === 'pending' ? 'row-alert' : '' },
        h('td', {}, h('strong', { text: s.name }), h('div', { class: 'muted small' }, s.email, ' · ', h('a', { href: `#studentview/${encodeURIComponent(s.id)}` }, '👁 what they see'))),
        s.status === 'pending'
          ? h('td', { colspan: 3 }, h('span', { class: 'badge badge-warn', text: 'Asked to join' }), ' ', h('button', { class: 'btn btn-primary', onclick: () => act(() => api('POST', `/api/classes/${c.id}/students/${encodeURIComponent(s.id)}/approve`), `${s.name} approved.`) }, 'Approve'))
          : [
              h('td', {}, h('input', { type: 'checkbox', checked: s.readAloud, 'aria-label': 'Read-aloud', onchange: (e) => update(s, { readAloud: e.target.checked }) })),
              h('td', {}, h('input', { type: 'checkbox', checked: s.voiceAnswers, 'aria-label': 'Voice answers', onchange: (e) => update(s, { voiceAnswers: e.target.checked }) })),
              h('td', {}, h('select', { 'aria-label': 'Extra time', onchange: (e) => update(s, { extraTimePct: Number(e.target.value) }) }, [0, 25, 33, 50, 100].map((x) => h('option', { value: x, selected: x === s.extraTimePct }, x ? `+${x}%` : 'none')))),
            ],
        h('td', {}, h('button', { class: 'btn btn-ghost danger', onclick: () => act(() => api('DELETE', `/api/classes/${c.id}/students/${encodeURIComponent(s.id)}`), `${s.name} removed from ${c.name}.`) }, s.status === 'pending' ? 'Decline' : 'Remove')),
      );

    return h(
      'details',
      { class: 'card class-card', open: classes.length <= 2 || pending.length > 0 },
      h('summary', {}, h('strong', { text: c.name }), h('span', { class: 'muted', text: ` · ${active.length} student${active.length === 1 ? '' : 's'}` }), pending.length ? h('span', { class: 'badge badge-warn', text: `${pending.length} waiting` }) : null, c.ownerId !== BOOT.user.id ? h('span', { class: 'muted small', text: ` · ${c.ownerId}` }) : null),
      h('div', { class: 'form' },
        h('div', { class: 'row' }, name, h('button', { class: 'btn btn-ghost danger', onclick: () =>
          modal(`Delete the class ${c.name}?`, h('p', { text: 'Students stay in the system with their results; they’re just no longer in this class.' }), [
            ['Cancel', null],
            ['Delete class', () => act(() => api('DELETE', `/api/classes/${c.id}`), 'Class deleted.'), 'btn-danger'],
          ]) }, 'Delete class')),
        join,
        classroom,
        c.students.length
          ? h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Student', 'Read-aloud', 'Voice answers', 'Extra time', ''].map((x) => h('th', { text: x })))), h('tbody', {}, [...pending, ...active].map(studentRow)))
          : h('p', { class: 'muted', text: 'No students yet: share the class code, import from Classroom, or add by email.' }),
        addByEmail,
      ),
    );
  }

  const newName = h('input', { placeholder: 'e.g. 10-3 English', class: 'grow' });
  page(
    h('div', { class: 'page-head' }, h('h1', { text: 'Classes' })),
    h('div', { class: 'card row' }, newName, h('button', { class: 'btn btn-primary', onclick: () => newName.value.trim() ? act(() => api('POST', '/api/classes', { name: newName.value }), 'Class created.') : toast('Give the class a name.', 'warn') }, '+ New class')),
    classroomNeedsSetup ? h('p', { class: 'small muted', text: 'Google Classroom import is off. To turn it on, update the app’s manifest as described in the update instructions.' }) : null,
    classes.length ? classes.map(classCard) : h('p', { class: 'muted', text: 'No classes yet. Create one above.' }),
  );
}

// ================================================================== teachers

async function teachersPage() {
  const { teachers } = await api('GET', '/api/teachers');
  const email = h('input', { type: 'email', placeholder: 'colleague@school.org', class: 'grow' });
  const shareBox = h('div');
  page(
    h('div', { class: 'page-head' }, h('h1', { text: 'Teachers' })),
    h('p', { class: 'muted', text: 'Teachers at your school can use this app with their own classes, tests and students. They only see their own; you (the admin) see everything.' }),
    h(
      'table',
      { class: 'table' },
      h('thead', {}, h('tr', {}, ['Teacher', 'Classes', 'Tests', ''].map((x) => h('th', { text: x })))),
      h('tbody', {}, teachers.map((t) =>
        h('tr', {}, h('td', {}, h('strong', { text: t.email }), t.admin ? h('span', { class: 'badge', text: 'admin' }) : null), h('td', { text: t.classes }), h('td', { text: t.tests }),
          h('td', {}, t.admin ? null : h('button', { class: 'btn btn-ghost danger', onclick: async () => {
            try { await api('DELETE', `/api/teachers/${encodeURIComponent(t.id)}`); route(); } catch (e) { toast(e.message, 'error'); }
          } }, 'Remove')),
        ),
      )),
    ),
    h('div', { class: 'card row' }, email, h('button', { class: 'btn btn-primary', onclick: async () => {
      try {
        await api('POST', '/api/teachers', { email: email.value });
        toast('Added. Send them the app link: they open it and see their own empty Tests page.', 'ok');
        route();
      } catch (e) {
        toast(e.message, 'error');
      }
    } }, 'Add teacher')),
    h(
      'div',
      { class: 'card form' },
      h('h2', { text: 'A teacher at another school' }),
      h('p', { text: 'Google only tells this app the email of people at your school, so teachers elsewhere need their own copy. This makes a copy of the app without any of your data, with a link they can use to install it (about 5 minutes, no code).' }),
      h('div', {}, h('button', { class: 'btn', onclick: async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Making a copy…';
        try {
          const r = await api('POST', '/api/admin/install-copy');
          clear(
            shareBox,
            h('p', {}, 'Send them this link: ', h('a', { href: r.copyLink, target: '_blank', rel: 'noopener', text: r.copyLink })),
            r.sharing === 'anyone' ? null : h('p', { class: 'error', text: r.sharing === 'school' ? 'Your school only allows sharing inside the school, so this link works for teachers here only. To share outside, open the file and change its sharing (if your school allows it).' : 'The copy could not be shared automatically. Open it and share it with "Anyone with the link".' }),
            h('p', { class: 'small muted' }, 'The copy is in your Google Drive: ', h('a', { href: r.fileUrl, target: '_blank', rel: 'noopener' }, 'open it'), '. Its first tab has the setup steps.'),
          );
        } catch (err) {
          toast(err.message, 'error');
        }
        e.target.disabled = false;
        e.target.textContent = 'Make an installable copy';
      } }, 'Make an installable copy')),
      shareBox,
    ),
  );
}

// ================================================================== settings

// Backups: daily (kept 30 days), before every update, and on demand.
function backupsCard(b) {
  const box = h('div', { class: 'card form', id: 'backups' });
  const draw = (b) => {
    const daily = h('input', { type: 'checkbox', checked: b.daily });
    daily.addEventListener('change', async () => {
      try {
        draw(await api('PUT', '/api/backups', { daily: daily.checked }));
        toast(daily.checked ? 'Daily backups are on.' : 'Daily backups are off.', 'ok');
      } catch (e) {
        daily.checked = !daily.checked;
        toast(e.message, 'error');
      }
    });
    const now = h('button', { class: 'btn btn-primary' }, 'Back up now');
    now.addEventListener('click', async () => {
      try {
        const r = await api('POST', '/api/backups');
        draw(r);
        toast(`Backed up: ${r.made.name}`, 'ok');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    clear(
      box,
      h('h2', { text: 'Backups' }),
      h('p', { class: 'muted', text: `Each backup is a separate Google Sheet with a copy of all students, classes, tests, answers, marks and the activity log. The app makes one every night (kept for ${b.keepDays} days) and one automatically before an update changes anything. Voice answers stay in their Drive folder and are never deleted by an update.` }),
      b.error ? h('p', { class: 'error', text: `${b.error} Update the app’s manifest (appsscript.json) as in the update instructions and run "authorize" once.` }) : null,
      h('label', { class: 'check' }, daily, `Back up every night (kept for ${b.keepDays} days)`),
      h('div', { class: 'row' }, now, h('span', { class: 'muted', text: b.lastBackup ? `Last backup: ${fmtDate(b.lastBackup)}` : 'No backup yet.' }), h('a', { href: b.folderUrl, target: '_blank', rel: 'noopener' }, 'Open the backups folder')),
      b.backups.length
        ? h('details', {}, h('summary', { text: `Recent backups (${b.backups.length})` }), h('ul', { class: 'backup-list' }, b.backups.slice(0, 20).map((x) => h('li', {}, h('a', { href: x.url, target: '_blank', rel: 'noopener', text: x.name })))))
        : null,
      h('details', {}, h('summary', { text: 'How to restore from a backup' }), h('ol', {},
        h('li', { text: 'Make one more backup now, so the current state is kept too.' }),
        h('li', { text: 'Open the backup you want. Right-click the tab you need (for example attempts) → Copy to → Existing spreadsheet → choose the app’s Sheet.' }),
        h('li', { text: 'In the app’s Sheet, rename the broken tab (for example to "attempts old") and rename the copied tab to the exact original name ("attempts"). Do the same for any other tab you need.' }),
        h('li', { text: 'Reload the app. Nothing else is needed: the app finds its data by the tab and column names.' }),
      )),
    );
  };
  draw(b);
  return box;
}

async function settingsPage() {
  const [settings, backups] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/backups').catch((e) => ({ error: e.message, backups: [], keepDays: 30, daily: false, folderUrl: '#' }))]);
  const recorderUrl = h('input', { value: settings.recorderUrl, class: 'grow' });
  page(
    h('div', { class: 'page-head' }, h('h1', { text: 'Settings' })),
    backupsCard(backups),
    h(
      'div',
      { class: 'card form' },
      h(
        'p',
        {},
        'All data is kept in ',
        h('a', { href: settings.spreadsheetUrl, target: '_blank', rel: 'noopener' }, 'this Google Sheet'),
        settings.recordingsUrl ? ' and voice answers in ' : '. ',
        settings.recordingsUrl ? h('a', { href: settings.recordingsUrl, target: '_blank', rel: 'noopener' }, 'this Drive folder') : null,
        settings.recordingsUrl ? '. ' : null,
        'Don’t rename or delete the sheet’s tabs or column headings.',
      ),
      settings.recordingsUrl ? null : h('p', { class: 'error', text: 'Voice answers are not set up: the app has no permission to use Google Drive. In the Apps Script editor, choose "authorize" in the function list at the top, click Run, and tick every box.' }),
      h('p', {}, 'Google Classroom import: ', h('strong', { text: settings.classroomEnabled ? 'on' : 'off' }), settings.classroomEnabled ? '' : ' (update the app’s manifest to turn it on, as in the update instructions).'),
      h('label', {}, 'Voice recorder page (the pop-up students record in)', recorderUrl),
      h(
        'div',
        { class: 'row end' },
        h('button', {
          class: 'btn',
          onclick: async () => {
            try {
              const r = await api('PUT', '/api/settings', { recorderUrl: recorderUrl.value });
              BOOT.recorderUrl = r.recorderUrl;
              recorderUrl.value = r.recorderUrl;
              toast('Saved.', 'ok');
            } catch (e) {
              toast(e.message, 'error');
            }
          },
        }, 'Save'),
      ),
      voiceSettings(settings.voices || {}),
    ),
  );
}

// Where natural read-aloud voices come from. Keys are saved on the server and
// never shown again; leave a key box empty to keep the saved one.
function voiceSettings(v) {
  const googleKey = h('input', { type: 'password', class: 'grow', autocomplete: 'off', placeholder: v.googleKeySet ? 'Saved ✓ (type a new key to replace it)' : 'Paste your Google Cloud API key' });
  const cbUrl = h('input', { class: 'grow', value: v.chatterboxUrl || '', placeholder: 'https://your-tunnel.trycloudflare.com' });
  const cbKey = h('input', { type: 'password', class: 'grow', autocomplete: 'off', placeholder: v.chatterboxKeySet ? 'Saved ✓' : 'Only if your server needs one' });
  const save = async (extra) => {
    try {
      const body = Object.assign({ chatterboxUrl: cbUrl.value }, extra);
      if (googleKey.value.trim()) body.googleKey = googleKey.value.trim();
      if (cbKey.value.trim()) body.chatterboxKey = cbKey.value.trim();
      const r = await api('PUT', '/api/settings/voices', body);
      googleKey.value = '';
      cbKey.value = '';
      googleKey.placeholder = r.voices.googleKeySet ? 'Saved ✓ (type a new key to replace it)' : 'Paste your Google Cloud API key';
      cbKey.placeholder = r.voices.chatterboxKeySet ? 'Saved ✓' : 'Only if your server needs one';
      toast('Saved.', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return h(
    'div',
    { class: 'form voice-settings' },
    h('h3', { text: 'Read-aloud voices' }),
    h('p', { class: 'small muted', text: 'Optional. Each test can use the free device voice, or a natural voice from one of these. Choose the voice in each test under "Read-aloud voice". The README explains how to get a key or set up Chatterbox.' }),
    h('label', {}, 'Google Cloud Text-to-Speech key', googleKey),
    h('label', {}, 'Chatterbox server address', cbUrl),
    h('label', {}, 'Chatterbox key', cbKey),
    h(
      'div',
      { class: 'row end' },
      v.googleKeySet ? h('button', { class: 'btn btn-ghost danger', type: 'button', onclick: () => save({ googleKey: '' }) }, 'Remove Google key') : null,
      h('button', { class: 'btn', type: 'button', onclick: () => save({}) }, 'Save voices'),
    ),
  );
}

// ============================================================ student view

// #preview/<test>/<options>: options say which student or accommodations to
// show, whether to simulate exam mode, and where "Close" goes.
App.previewHash = function (testId, o) {
  const p = new URLSearchParams();
  if (o.studentId) p.set('as', o.studentId);
  if (o.readAloud) p.set('ra', '1');
  if (o.voiceAnswers) p.set('va', '1');
  if (o.extraTimePct) p.set('xt', String(o.extraTimePct));
  if (o.exam) p.set('exam', '1');
  if (o.back) p.set('back', o.back);
  return `#preview/${testId}/${p.toString()}`;
};

App.parsePreview = function (rest) {
  const p = new URLSearchParams(rest || '');
  return {
    studentId: p.get('as') || '',
    readAloud: p.get('ra') === '1',
    voiceAnswers: p.get('va') === '1',
    extraTimePct: Number(p.get('xt')) || 0,
    exam: p.get('exam') === '1',
    back: p.get('back') || '#tests',
  };
};

// A student's home page, as they see it.
async function studentHomePage(studentId) {
  const { student: s, tests } = await api('GET', `/api/students/${encodeURIComponent(studentId)}/home`);
  const back = `#studentview/${encodeURIComponent(s.id)}`;
  const view = { studentId: s.id, readAloud: s.readAloud, voiceAnswers: s.voiceAnswers, extraTimePct: s.extraTimePct, back };
  const status = (t) => {
    const a = t.attempt;
    if (!a) return t.testOpen ? h('a', { class: 'btn btn-primary', href: App.previewHash(t.id, view) }, 'Start (student view)') : h('span', { class: 'muted', text: 'Closed' });
    const label = { in_progress: 'Working on it now', locked: 'Paused, waiting for you to unlock', submitted: `Submitted ${fmtDate(a.submittedAt)} · waiting for grading`, returned: 'Graded and returned' }[a.status];
    return h('div', { class: 'row tight' }, h('span', { class: `badge badge-${a.status}`, text: label }), a.score !== null ? h('span', { class: 'badge badge-ok', text: `${a.score} / ${a.maxScore}` }) : null);
  };
  page(
    h(
      'div',
      { class: 'preview-bar' },
      h('strong', { text: '👁 Student view' }),
      h('span', {}, 'This is the page ', h('strong', { text: s.name }), ' sees when they open the app.'),
      h('span', { class: 'muted', text: [s.readAloud && 'read-aloud', s.voiceAnswers && 'voice answers', s.extraTimePct && `+${s.extraTimePct}% time`].filter(Boolean).join(' · ') || 'no accommodations' }),
      h('a', { class: 'btn btn-ghost', href: '#classes' }, '✕ Close'),
    ),
    h('h1', { text: `Hi ${s.name}` }),
    tests.length
      ? h(
          'div',
          { class: 'cards' },
          tests.map((t) =>
            h(
              'div',
              { class: 'card test-card' },
              h('h2', { text: t.title }),
              h('p', { class: 'muted' }, `${t.questionCount} questions`, t.timeLimitMin ? ` · ${Math.round(t.timeLimitMin * (1 + t.extraTimePct / 100))} minutes` : ' · no time limit'),
              status(t),
            ),
          ),
        )
      : h('p', { class: 'muted', text: 'No tests for them right now. A test shows up here when it is Open and set for their class (or for all classes).' }),
  );
}

// ==================================================================== router

function route() {
  App.route();
}

App.teacherRoute = async function (name, arg, rest) {
  clearTimeout(refreshTimer);
  leaveGuard = null;
  try {
    if (name === 'preview') return App.take(arg, { preview: true, view: App.parsePreview(rest) });
    if (name === 'studentview') await studentHomePage(arg);
    else if (name === 'edit') await editorPage(arg);
    else if (name === 'results') await resultsPage(arg);
    else if (name === 'grade') await gradePage(arg);
    else if (name === 'classes' || name === 'people') await classesPage();
    else if (name === 'teachers') await teachersPage();
    else if (name === 'settings') await settingsPage();
    else await testsPage();
  } catch (e) {
    page(h('p', { class: 'error', text: e.message }));
  }
};

App.teacherHasUnsaved = () => !!(leaveGuard && leaveGuard());
})();
