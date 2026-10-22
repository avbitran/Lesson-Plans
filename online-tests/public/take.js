import { api, h, clear, toast, modal, fmtDuration, isRtl, LETTERS, requireUser } from './common.js';
import { Reader, Recorder, ttsSupported, recordingSupported, getMicrophone } from './speech.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const PREVIEW = params.has('preview');
const TEST_ID = params.get('preview') || params.get('test');
const CLIENT_ID = crypto.randomUUID();

const state = {
  test: null,
  attempt: null,
  answers: {},
  recordings: {}, // questionId -> { id, duration, url? }
  acc: { readAloud: true, voiceAnswers: true },
  dirty: false,
  saving: false,
  lastSaved: null,
  clockOffset: 0,
  finished: false, // submitted, or the page is closing down on purpose
  away: false,
  violations: 0,
  recorder: null,
};

let reader;

// ------------------------------------------------------------------ network

async function call(method, url, body, opts) {
  if (PREVIEW) return {};
  try {
    return await api(method, url, body, opts);
  } catch (e) {
    if (e.status === 423) showLocked();
    else if (e.status === 409) finish(e.message);
    throw e;
  }
}

async function save() {
  if (!state.dirty || state.saving || state.finished || PREVIEW) return;
  state.saving = true;
  state.dirty = false;
  setSaveStatus('Saving…');
  try {
    const r = await call('PUT', `/api/my/attempts/${state.attempt.id}/answers`, { clientId: CLIENT_ID, answers: state.answers });
    state.lastSaved = Date.now();
    if (r.deadlineAt) state.attempt.deadlineAt = r.deadlineAt;
    if (r.serverNow) state.clockOffset = r.serverNow - Date.now();
    setSaveStatus('All answers saved');
  } catch (e) {
    state.dirty = true;
    if (!e.status) setSaveStatus('Offline — will retry', true);
  } finally {
    state.saving = false;
  }
}

function changed(qid, value) {
  if (value === '' || value === undefined) delete state.answers[qid];
  else state.answers[qid] = value;
  state.dirty = true;
  setSaveStatus('Unsaved changes');
  updateProgress();
}

const lastLogged = {};
function report(type, detail = '') {
  if (PREVIEW || state.finished) return;
  // Blocked copy/paste/shortcuts are logged at most once every 10 seconds.
  if (!['left', 'fullscreen_exit', 'returned'].includes(type)) {
    if (Date.now() - (lastLogged[type] || 0) < 10e3) return;
    lastLogged[type] = Date.now();
  }
  return api('POST', `/api/my/attempts/${state.attempt.id}/events`, { clientId: CLIENT_ID, type, detail })
    .then((r) => {
      if (r.violations !== undefined) state.violations = r.violations;
      if (r.status === 'locked') showLocked();
      else if (r.status === 'submitted' && !state.finished) finish('Your test was submitted automatically because you left it too many times.');
    })
    .catch(() => {});
}

// ----------------------------------------------------------------- lockdown

const settings = () => state.test.settings;

async function enterFullscreen() {
  if (PREVIEW || !settings().requireFullscreen) return true;
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    // On Chrome/ChromeOS this captures Esc (it must be held to exit) and
    // system shortcuts like Alt+Tab while the test is fullscreen.
    await navigator.keyboard?.lock?.().catch(() => {});
    return true;
  } catch {
    report('fullscreen_refused');
    return false;
  }
}

// Window blur and tab hide usually fire together; state.away logs them once.
function leftTest(detail) {
  if (state.finished || state.away || PREVIEW) return;
  state.away = true;
  state.awayAt = Date.now();
  reader?.stop();
  state.leftReport = report('left', detail);
}

function cameBack() {
  if (!state.away || state.finished) return;
  state.away = false;
  const seconds = Math.round((Date.now() - state.awayAt) / 1000);
  report('returned', `away ${seconds}s`);
  Promise.resolve(state.leftReport).finally(() => warnAboutLeaving(seconds));
}

function warnAboutLeaving(seconds) {
  if (state.finished || document.querySelector('.overlay-locked')) return;
  const max = settings().maxViolations;
  const n = state.violations;
  const consequence =
    max && settings().onLimit === 'lock'
      ? `After ${max} times the test is paused until your teacher unlocks it.`
      : max && settings().onLimit === 'submit'
        ? `After ${max} times the test is submitted automatically.`
        : '';
  modal(
    'You left the test',
    h(
      'div',
      {},
      h('p', { text: `You were away for ${seconds} second${seconds === 1 ? '' : 's'}. Your teacher can see every time you leave the test.` }),
      max ? h('p', { class: 'strong', text: `Warning ${Math.min(n, max)} of ${max}. ${consequence}` }) : null,
    ),
    [['Back to the test', () => enterFullscreen(), 'btn-primary']],
  );
}

function installLockdown() {
  if (PREVIEW) return;
  document.addEventListener('visibilitychange', () => (document.hidden ? leftTest('Switched tab or minimised') : cameBack()));
  window.addEventListener('blur', () => {
    // Clicking into an <audio> element's controls doesn't blur the window; anything that does is outside the page.
    leftTest('Clicked outside the test window');
  });
  window.addEventListener('focus', cameBack);

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement || state.finished || !settings().requireFullscreen) return;
    report('fullscreen_exit');
    showFullscreenGate();
  });

  if (settings().blockCopyPaste) {
    for (const ev of ['copy', 'cut']) document.addEventListener(ev, (e) => (e.preventDefault(), report('copy_blocked')));
    document.addEventListener('paste', (e) => (e.preventDefault(), report('paste_blocked'), toast('Pasting is turned off during the test.')));
    document.addEventListener('drop', (e) => e.preventDefault());
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const devtools = e.key === 'F12' || (mod && e.shiftKey && ['i', 'j', 'c'].includes(k));
    const blocked = devtools || (mod && ['p', 's', 'u', 'o', 'n', 't', 'w'].includes(k));
    if (blocked) {
      e.preventDefault();
      report('shortcut_blocked', `${mod ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key}`);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.finished) return;
    save();
    e.preventDefault();
    e.returnValue = '';
  });
}

function showFullscreenGate() {
  if (document.querySelector('.overlay-fs')) return;
  const ov = h(
    'div',
    { class: 'overlay overlay-fs', role: 'alertdialog' },
    h(
      'div',
      { class: 'overlay-box' },
      h('h2', { text: 'The test must stay in full screen' }),
      h('p', { text: 'Leaving full screen was recorded. Go back to continue your test.' }),
      h(
        'button',
        {
          class: 'btn btn-primary btn-big',
          onclick: async () => {
            if (await enterFullscreen()) ov.remove();
          },
        },
        'Return to full screen',
      ),
    ),
  );
  document.body.append(ov);
}

let lockPoll = null;
function showLocked() {
  if (document.querySelector('.overlay-locked') || state.finished) return;
  reader?.stop();
  state.recorder?.stop();
  document.querySelectorAll('dialog').forEach((d) => d.remove());
  const ov = h(
    'div',
    { class: 'overlay overlay-locked', role: 'alertdialog' },
    h(
      'div',
      { class: 'overlay-box' },
      h('h2', { text: 'Your test is paused' }),
      h('p', { text: 'You left the test too many times. Your answers are saved. Ask your teacher to unlock it.' }),
      h('p', { class: 'muted', text: 'This page will continue by itself once your teacher unlocks it.' }),
    ),
  );
  document.body.append(ov);
  clearInterval(lockPoll);
  lockPoll = setInterval(async () => {
    try {
      const s = await api('GET', `/api/my/attempts/${state.attempt.id}/status`);
      if (s.status === 'in_progress') {
        clearInterval(lockPoll);
        state.attempt.deadlineAt = s.deadlineAt;
        state.clockOffset = s.serverNow - Date.now();
        clear(
          ov.firstChild,
          h('h2', { text: 'Your teacher unlocked the test' }),
          h(
            'button',
            {
              class: 'btn btn-primary btn-big',
              onclick: async () => {
                await enterFullscreen();
                ov.remove();
              },
            },
            'Continue the test',
          ),
        );
      } else if (s.status !== 'locked') {
        clearInterval(lockPoll);
        finish('Your teacher ended the test. Your saved answers were submitted.');
      }
    } catch {}
  }, 5000);
}

// --------------------------------------------------------------- the timer

let timerEl;
const warned = new Set();
function tick() {
  if (!state.attempt?.deadlineAt || state.finished) return;
  const left = (state.attempt.deadlineAt - (Date.now() + state.clockOffset)) / 1000;
  timerEl.textContent = `⏱ ${fmtDuration(left)}`;
  timerEl.classList.toggle('timer-low', left < 300);
  for (const mins of [5, 1]) {
    if (left < mins * 60 && left > mins * 60 - 30 && !warned.has(mins)) {
      warned.add(mins);
      toast(`${mins} minute${mins > 1 ? 's' : ''} left.`, 'warn');
    }
  }
  if (left <= 0 && !PREVIEW) submit('time');
}

// ------------------------------------------------------------- rendering

let saveEl, progressEl;
function setSaveStatus(text, bad = false) {
  if (!saveEl) return;
  saveEl.textContent = text;
  saveEl.classList.toggle('bad', bad);
}

function answerable() {
  return state.test.questions.filter((q) => q.type !== 'section');
}

function isAnswered(q) {
  return state.answers[q.id] !== undefined || !!state.recordings[q.id];
}

function updateProgress() {
  if (!progressEl) return;
  const qs = answerable();
  progressEl.textContent = `${qs.filter(isAnswered).length} / ${qs.length} answered`;
}

function speakText(q) {
  const parts = [q.title, q.prompt];
  if (q.type === 'mc') q.options.forEach((o, i) => parts.push(`${LETTERS[i]}. ${o}.`));
  return parts.filter(Boolean).join('. \n');
}

function listenButton(text, card) {
  if (!state.acc.readAloud || !ttsSupported) return null;
  const btn = h('button', { class: 'btn btn-listen', type: 'button', 'aria-label': 'Read aloud' }, '🔊 Listen');
  btn.addEventListener('click', () => {
    if (card.classList.contains('reading')) return reader.stop();
    reader.speak(text, {
      onStart: () => {
        card.classList.add('reading');
        btn.textContent = '⏹ Stop';
      },
      onEnd: () => {
        card.classList.remove('reading');
        btn.textContent = '🔊 Listen';
      },
    });
  });
  return btn;
}

function recordWidget(q) {
  if (!state.acc.voiceAnswers) return null;
  const box = h('div', { class: 'record' });
  const draw = () => {
    const r = state.recordings[q.id];
    if (!recordingSupported) return clear(box, h('p', { class: 'muted', text: 'Voice recording is not supported in this browser.' }));
    const recordBtn = h('button', { class: 'btn btn-record', type: 'button' }, r ? '🎤 Record again' : '🎤 Record my answer');
    recordBtn.addEventListener('click', () => startRecording(q, box, draw));
    clear(
      box,
      r
        ? h(
            'div',
            { class: 'record-done' },
            h('span', { class: 'ok', text: `✓ Voice answer saved (${fmtDuration(r.duration || 0)})` }),
            h('audio', { controls: true, preload: 'metadata', src: r.url || `/api/recordings/${r.id}` }),
            h('div', { class: 'row' }, recordBtn, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => deleteRecording(q, draw) }, 'Delete')),
          )
        : recordBtn,
    );
  };
  draw();
  return box;
}

async function startRecording(q, box, draw) {
  if (state.recorder?.recording) return toast('Stop the other recording first.');
  reader?.stop();
  const timer = h('span', { class: 'rec-time', text: '0:00' });
  const stopBtn = h('button', { class: 'btn btn-stop', type: 'button' }, '⏹ Stop recording');
  const rec = new Recorder({
    maxSeconds: 300,
    onTick: (s) => (timer.textContent = fmtDuration(s)),
    onStop: async (blob, seconds) => {
      state.recorder = null;
      clear(box, h('span', { class: 'muted', text: 'Saving recording…' }));
      try {
        if (PREVIEW) {
          state.recordings[q.id] = { id: 0, duration: seconds, url: URL.createObjectURL(blob) };
        } else {
          const r = await call(
            'POST',
            `/api/my/attempts/${state.attempt.id}/recordings?q=${encodeURIComponent(q.id)}&duration=${seconds.toFixed(1)}&clientId=${CLIENT_ID}`,
            blob,
          );
          state.recordings[q.id] = { id: r.id, duration: r.duration };
        }
      } catch (e) {
        toast(`The recording was not saved: ${e.message}`, 'error');
      }
      draw();
      updateProgress();
    },
  });
  try {
    await rec.start();
  } catch {
    return toast('The microphone is blocked. Ask your teacher for help.', 'error');
  }
  state.recorder = rec;
  stopBtn.addEventListener('click', () => rec.stop());
  clear(box, h('div', { class: 'recording' }, h('span', { class: 'rec-dot' }), 'Recording ', timer, stopBtn));
}

async function deleteRecording(q, draw) {
  const r = state.recordings[q.id];
  if (!r) return;
  try {
    if (!PREVIEW) await call('DELETE', `/api/my/attempts/${state.attempt.id}/recordings/${r.id}?clientId=${CLIENT_ID}`);
    delete state.recordings[q.id];
  } catch (e) {
    toast(e.message, 'error');
  }
  draw();
  updateProgress();
}

function questionCard(q, number) {
  const card = h('section', { class: `q q-${q.type}`, id: `q-${q.id}` });
  if (q.type === 'section') {
    card.append(
      h('div', { class: 'q-head' }, q.title ? h('h2', { text: q.title }) : null, listenButton(speakText(q), card)),
      q.prompt ? h('div', { class: 'passage', text: q.prompt }) : null,
    );
    return card;
  }
  const head = h(
    'div',
    { class: 'q-head' },
    h('span', { class: 'q-num', text: number }),
    h('div', { class: 'q-text' }, q.title ? h('strong', { text: q.title }) : null, h('div', { class: 'prompt', text: q.prompt })),
    h('span', { class: 'q-points', text: `${q.points} pt${q.points === 1 ? '' : 's'}` }),
    listenButton(speakText(q), card),
  );
  card.append(head);

  if (q.type === 'mc') {
    const name = `mc-${q.id}`;
    card.append(
      h(
        'div',
        { class: 'options', role: 'radiogroup' },
        q.options.map((o, i) =>
          h(
            'label',
            { class: 'option' },
            h('input', {
              type: 'radio',
              name,
              value: i,
              checked: state.answers[q.id] === i,
              onchange: () => changed(q.id, i),
            }),
            h('span', { class: 'letter', text: LETTERS[i] }),
            h('span', { text: o }),
          ),
        ),
      ),
    );
  } else {
    const attrs = {
      value: state.answers[q.id] ?? '',
      spellcheck: 'false',
      autocomplete: 'off',
      autocorrect: 'off',
      'aria-label': `Answer to question ${number}`,
      oninput: (e) => changed(q.id, e.target.value),
      onblur: save,
    };
    card.append(
      q.type === 'short'
        ? h('input', { ...attrs, class: 'answer answer-short', placeholder: 'Type your answer' })
        : h('textarea', { ...attrs, class: 'answer answer-long', rows: 6, placeholder: 'Write your answer' }),
    );
  }
  const rec = recordWidget(q);
  if (rec) card.append(h('div', { class: 'or', text: state.acc.voiceAnswers ? 'or answer out loud:' : '' }), rec);
  return card;
}

function textSizeControls() {
  const sizes = [18, 20, 23, 26, 30];
  let i = 1;
  try {
    i = Math.max(0, Math.min(sizes.length - 1, Number(localStorage.getItem('fs')) || 1));
  } catch {}
  const apply = () => {
    document.documentElement.style.setProperty('--test-fs', `${sizes[i]}px`);
    try {
      localStorage.setItem('fs', i);
    } catch {}
  };
  apply();
  return h(
    'div',
    { class: 'row tight', 'aria-label': 'Text size' },
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => (i = Math.max(0, i - 1), apply()), 'aria-label': 'Smaller text' }, 'A−'),
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => (i = Math.min(sizes.length - 1, i + 1), apply()), 'aria-label': 'Bigger text' }, 'A+'),
  );
}

function speedControl() {
  if (!state.acc.readAloud || !ttsSupported) return null;
  const sel = h(
    'select',
    { 'aria-label': 'Reading speed', onchange: (e) => (reader.rate = Number(e.target.value)) },
    [
      ['0.7', 'Slow'],
      ['0.85', 'A bit slow'],
      ['1', 'Normal'],
      ['1.15', 'Fast'],
    ].map(([v, l]) => h('option', { value: v, selected: v === '0.85' }, `🔊 ${l}`)),
  );
  reader.rate = 0.85;
  return sel;
}

function renderTest() {
  const t = state.test;
  timerEl = h('span', { class: 'timer' });
  saveEl = h('span', { class: 'save-status', text: PREVIEW ? 'Preview: nothing is saved' : 'All answers saved' });
  progressEl = h('span', { class: 'progress' });
  let n = 0;
  const body = h(
    'main',
    { class: 'test', dir: isRtl(t.language) ? 'rtl' : 'ltr', lang: t.language },
    h('div', { class: 'test-title' }, h('h1', { text: t.title })),
    t.instructions
      ? (() => {
          const card = h('section', { class: 'q q-section instructions' });
          card.append(h('div', { class: 'q-head' }, h('h2', { text: 'Instructions' }), listenButton(t.instructions, card)), h('div', { class: 'passage', text: t.instructions }));
          return card;
        })()
      : null,
    t.questions.map((q) => questionCard(q, q.type === 'section' ? null : ++n)),
    h(
      'div',
      { class: 'submit-row' },
      h('button', { class: 'btn btn-primary btn-big', type: 'button', onclick: confirmSubmit }, PREVIEW ? 'Submit (preview)' : 'Submit test'),
    ),
  );
  clear(
    app,
    PREVIEW ? h('div', { class: 'preview-banner', text: 'Teacher preview: exam mode is off and nothing is saved. Read-aloud and voice answers are shown as a student with both accommodations sees them.' }) : null,
    h(
      'header',
      { class: 'test-bar' },
      h('div', { class: 'row tight' }, timerEl, progressEl),
      h('div', { class: 'row tight' }, saveEl, speedControl(), textSizeControls(), h('button', { class: 'btn btn-primary', type: 'button', onclick: confirmSubmit }, 'Submit')),
    ),
    body,
  );
  updateProgress();
  tick();
}

// ------------------------------------------------------------- submitting

function confirmSubmit() {
  const missing = answerable().filter((q) => !isAnswered(q)).length;
  if (state.recorder?.recording) return toast('Stop your recording first.', 'warn');
  modal(
    'Submit your test?',
    h(
      'div',
      {},
      missing ? h('p', { class: 'strong', text: `You have ${missing} unanswered question${missing > 1 ? 's' : ''}.` }) : h('p', { text: 'You answered every question.' }),
      h('p', { text: 'After you submit you cannot change your answers.' }),
    ),
    [
      ['Keep working', null],
      ['Submit', () => submit('student'), 'btn-primary'],
    ],
  );
}

async function submit(reason) {
  if (state.finished) return;
  if (PREVIEW) return finish('Preview finished. In a real test the answers would now go to you for grading.');
  state.recorder?.stop();
  state.submitting = true;
  try {
    await api('POST', `/api/my/attempts/${state.attempt.id}/submit`, { clientId: CLIENT_ID, answers: state.answers, reason });
    finish(reason === 'time' ? 'Time is up. Your test was submitted.' : 'Your test was submitted. Well done!');
  } catch (e) {
    if (e.status === 409) return finish(e.message);
    if (e.status === 423) return showLocked();
    state.submitting = false;
    toast(`Could not submit: ${e.message}. Check the internet connection and try again.`, 'error');
  }
}

function finish(message) {
  if (state.finished) return;
  state.finished = true;
  reader?.stop();
  clearInterval(lockPoll);
  navigator.keyboard?.unlock?.();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  document.querySelectorAll('.overlay, dialog').forEach((d) => d.remove());
  clear(
    app,
    h(
      'main',
      { class: 'center' },
      h(
        'div',
        { class: 'card narrow done' },
        h('h1', { text: '✓ Done' }),
        h('p', { text: message }),
        h('a', { class: 'btn btn-primary btn-big', href: PREVIEW ? '/teacher' : '/student' }, PREVIEW ? 'Back to my tests' : 'Back to my tests'),
      ),
    ),
  );
}

// ------------------------------------------------------------- start screen

function startScreen(info) {
  const t = state.test;
  const s = t.settings;
  const micStatus = h('span', { class: 'muted' });
  let micOk = false;
  const micBtn = state.acc.voiceAnswers && recordingSupported
    ? h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: async () => {
            try {
              await getMicrophone();
              micOk = true;
              micStatus.textContent = '✓ Microphone ready';
            } catch {
              micStatus.textContent = 'The microphone is blocked. You can still type your answers.';
            }
          },
        },
        '🎤 Allow the microphone',
      )
    : null;
  const minutes = info.timeLimitMin ? Math.round(info.timeLimitMin * (1 + (info.extraTimePct || 0) / 100)) : 0;
  const rules = [
    minutes ? `You have ${minutes} minutes${info.extraTimePct ? ` (including your extra time)` : ''}. The timer keeps running if you close the page.` : 'There is no time limit.',
    'Your answers save automatically.',
    s.requireFullscreen ? 'The test opens in full screen. Stay in it until you submit.' : null,
    'Leaving the test (another tab, another window or app) is recorded and your teacher sees it.',
    s.maxViolations && s.onLimit === 'lock' ? `If you leave ${s.maxViolations} times, the test is paused until your teacher unlocks it.` : null,
    s.maxViolations && s.onLimit === 'submit' ? `If you leave ${s.maxViolations} times, the test is submitted automatically.` : null,
    s.blockCopyPaste ? 'Copy and paste are turned off.' : null,
    state.acc.readAloud ? 'You can press 🔊 Listen on any question to hear it.' : null,
    state.acc.voiceAnswers ? 'You can record your answers out loud with 🎤.' : null,
  ].filter(Boolean);

  const startBtn = h('button', { class: 'btn btn-primary btn-big', type: 'button' }, info.resuming ? 'Continue the test' : 'Start the test');
  startBtn.addEventListener('click', async () => {
    if (micBtn && !micOk) {
      try {
        await getMicrophone();
      } catch {}
    }
    startBtn.disabled = true;
    const fsOk = await enterFullscreen();
    if (!fsOk && s.requireFullscreen) toast('Full screen was blocked. Leaving the test is still recorded.', 'warn');
    try {
      await begin();
    } catch (e) {
      startBtn.disabled = false;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      toast(e.message, 'error');
    }
  });

  clear(
    app,
    h(
      'main',
      { class: 'center' },
      h(
        'div',
        { class: 'card start', dir: isRtl(t.language) ? 'rtl' : 'ltr' },
        h('h1', { text: t.title }),
        h('ul', { class: 'rules' }, rules.map((r) => h('li', { text: r }))),
        micBtn ? h('div', { class: 'row' }, micBtn, micStatus) : null,
        h('div', { class: 'row' }, h('a', { class: 'btn btn-ghost', href: '/student' }, 'Back'), startBtn),
      ),
    ),
  );
}

async function begin() {
  const data = await api('POST', `/api/my/tests/${TEST_ID}/start`, { clientId: CLIENT_ID });
  load(data);
  installLockdown();
  renderTest();
  setInterval(tick, 1000);
  setInterval(save, 5000);
  // Notice a teacher lock / end from the server even when the student is idle.
  setInterval(async () => {
    if (state.finished || document.querySelector('.overlay-locked')) return;
    try {
      const s = await api('GET', `/api/my/attempts/${state.attempt.id}/status`);
      state.attempt.deadlineAt = s.deadlineAt;
      state.clockOffset = s.serverNow - Date.now();
      state.violations = s.violations;
      if (s.status === 'locked') showLocked();
      else if (s.status !== 'in_progress') finish('Your test was submitted.');
    } catch {}
  }, 20000);
  if (data.attempt.status === 'locked') showLocked();
}

function load(data) {
  state.test = data.test;
  state.attempt = data.attempt;
  state.answers = data.attempt.answers || {};
  state.violations = data.attempt.violations || 0;
  state.acc = data.accommodations;
  state.clockOffset = data.attempt.serverNow - Date.now();
  state.recordings = Object.fromEntries((data.recordings || []).map((r) => [r.questionId, r]));
  reader = new Reader({ lang: state.test.language });
}

// ---------------------------------------------------------------- startup

(async () => {
  if (!TEST_ID) return clear(app, h('p', { class: 'error', text: 'No test chosen.' }));
  try {
    if (PREVIEW) {
      await requireUser('teacher');
      const { test } = await api('GET', `/api/tests/${TEST_ID}/preview`);
      const started = Date.now();
      load({
        test,
        attempt: { id: 0, answers: {}, serverNow: started, deadlineAt: test.timeLimitMin ? started + test.timeLimitMin * 60e3 : null },
        accommodations: { readAloud: true, voiceAnswers: true },
      });
      renderTest();
      setInterval(tick, 1000);
      return;
    }
    await requireUser('student');
    const { tests } = await api('GET', '/api/my/tests');
    const info = tests.find((t) => String(t.id) === String(TEST_ID));
    if (!info) throw new Error('This test is not available to you.');
    if (info.attempt && !['in_progress', 'locked'].includes(info.attempt.status)) {
      return finish('You already submitted this test.');
    }
    // The rules screen comes before the clock starts.
    const data = await api('GET', `/api/my/tests/${TEST_ID}/rules`);
    state.test = data.test;
    state.acc = data.accommodations;
    startScreen({ ...info, resuming: !!info.attempt });
  } catch (e) {
    clear(app, h('main', { class: 'center' }, h('div', { class: 'card narrow' }, h('p', { class: 'error', text: e.message }), h('a', { class: 'btn', href: '/student' }, 'Back'))));
  }
})();
