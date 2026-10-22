// Taking a test (and the teacher's preview of it).
// App.take() builds one session; everything it installs checks that
// session's own `state`, so a finished session goes quiet.

App.take = function take(testId, { preview = false } = {}) {
  const app = document.getElementById('app');
  const PREVIEW = preview;
  const CLIENT_ID = crypto.randomUUID();
  const intervals = [];
  const every = (fn, ms) => intervals.push(setInterval(fn, ms));

  const state = {
    test: null,
    attempt: null,
    answers: {},
    recordings: {}, // questionId -> { id, duration, localUrl? }
    acc: { readAloud: true, voiceAnswers: true },
    dirty: false,
    saving: false,
    clockOffset: 0,
    finished: false,
    away: false,
    violations: 0,
    fsUnavailable: false,
    popup: null, // the recorder window, while open
    popupFocused: false,
  };
  App.activeTake = state;
  let reader;
  let lockPoll = null;
  state.preview = PREVIEW;
  // Called by the router when the teacher leaves a preview (or a student
  // goes back from the start screen).
  state.dispose = () => {
    state.finished = true;
    intervals.forEach(clearInterval);
    clearInterval(lockPoll);
    reader?.stop();
    closeRecorder();
  };

  // ---------------------------------------------------------------- network

  async function call(method, url, body) {
    if (PREVIEW) return {};
    try {
      return await api(method, url, body);
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

  // --------------------------------------------------------------- lockdown

  const settings = () => state.test.settings;
  const wantsFullscreen = () => !PREVIEW && settings().requireFullscreen && !state.fsUnavailable;

  async function enterFullscreen() {
    if (!wantsFullscreen()) return true;
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      // On Chrome/ChromeOS this asks to capture Esc (held to exit) and
      // system shortcuts like Alt+Tab while the test is fullscreen.
      await navigator.keyboard?.lock?.().catch(() => {});
      return true;
    } catch (e) {
      // Google's frame may not allow full screen. Carry on without it;
      // leaving the test is still detected and logged.
      state.fsUnavailable = true;
      report('fullscreen_refused', String((e && e.message) || e).slice(0, 120));
      return false;
    }
  }

  const popupOpen = () => state.popup && !state.popup.win.closed;

  // Window blur and tab hide usually fire together; state.away logs them once.
  function leftTest(detail) {
    if (state.finished || state.away || PREVIEW) return;
    state.away = true;
    state.awayAt = Date.now();
    reader?.stop();
    state.leftReport = report('left', detail);
  }

  // Focus moving to our own recorder window is not leaving the test, so wait
  // a moment and check where focus actually went.
  function checkFocusSoon(detail) {
    setTimeout(() => {
      if (!document.hasFocus() && !(popupOpen() && state.popupFocused)) leftTest(detail);
    }, 700);
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
        max ? h('p', { class: 'strong', text: `Warning ${Math.min(state.violations, max)} of ${max}. ${consequence}` }) : null,
      ),
      [['Back to the test', () => enterFullscreen(), 'btn-primary']],
    );
  }

  function installLockdown() {
    if (PREVIEW) return;
    document.addEventListener('visibilitychange', () => {
      if (state.finished) return;
      document.hidden ? leftTest('Switched tab or minimised') : cameBack();
    });
    window.addEventListener('blur', () => !state.finished && checkFocusSoon('Clicked outside the test window'));
    window.addEventListener('focus', cameBack);

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement || state.finished || !wantsFullscreen()) return;
      report('fullscreen_exit');
      showFullscreenGate();
    });

    const blockOn = () => !state.finished && settings().blockCopyPaste;
    for (const ev of ['copy', 'cut'])
      document.addEventListener(ev, (e) => {
        if (!blockOn()) return;
        e.preventDefault();
        report('copy_blocked');
      });
    document.addEventListener('paste', (e) => {
      if (!blockOn()) return;
      e.preventDefault();
      report('paste_blocked');
      toast('Pasting is turned off during the test.');
    });
    document.addEventListener('drop', (e) => blockOn() && e.preventDefault());
    document.addEventListener('contextmenu', (e) => blockOn() && e.preventDefault());
    document.addEventListener('keydown', (e) => {
      if (state.finished) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const devtools = e.key === 'F12' || (mod && e.shiftKey && ['i', 'j', 'c'].includes(k));
      if (devtools || (mod && ['p', 's', 'u', 'o'].includes(k))) {
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
        h('button', { class: 'btn btn-primary btn-big', onclick: async () => (await enterFullscreen(), ov.remove()) }, 'Return to full screen'),
      ),
    );
    document.body.append(ov);
  }

  function showLocked() {
    if (document.querySelector('.overlay-locked') || state.finished) return;
    reader?.stop();
    closeRecorder();
    document.querySelectorAll('dialog').forEach((d) => d.remove());
    const box = h(
      'div',
      { class: 'overlay-box' },
      h('h2', { text: 'Your test is paused' }),
      h('p', { text: 'You left the test too many times. Your answers are saved. Ask your teacher to unlock it.' }),
      h('p', { class: 'muted', text: 'This page will continue by itself once your teacher unlocks it.' }),
    );
    const ov = h('div', { class: 'overlay overlay-locked', role: 'alertdialog' }, box);
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
            box,
            h('h2', { text: 'Your teacher unlocked the test' }),
            h('button', { class: 'btn btn-primary btn-big', onclick: async () => (await enterFullscreen(), ov.remove()) }, 'Continue the test'),
          );
        } else if (s.status !== 'locked') {
          clearInterval(lockPoll);
          finish('Your teacher ended the test. Your saved answers were submitted.');
        }
      } catch (e) {
        // Try again on the next tick.
      }
    }, 8000);
  }

  // ------------------------------------------------------------- the timer

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

  // -------------------------------------------------------------- rendering

  let saveEl, progressEl;
  function setSaveStatus(text, bad = false) {
    if (!saveEl) return;
    saveEl.textContent = text;
    saveEl.classList.toggle('bad', bad);
  }

  const answerable = () => state.test.questions.filter((q) => q.type !== 'section');
  const isAnswered = (q) => state.answers[q.id] !== undefined || !!state.recordings[q.id];

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

  // ----------------------------------------------------- the recorder window
  // Apps Script pages can't use the microphone, so recording happens in a
  // small pop-up (recorder.html on GitHub Pages) that posts the audio back.

  function openRecorder(q, redraw) {
    if (popupOpen()) {
      state.popup.win.focus();
      return toast('Finish the recording in the recorder window first.');
    }
    reader?.stop();
    const url = `${BOOT.recorderUrl}?lang=${encodeURIComponent(state.test.language)}`;
    const win = window.open(url, 'ot-recorder', 'popup,width=480,height=460');
    if (!win) return toast('The recorder window was blocked. Allow pop-ups for this page and try again.', 'error');
    state.popup = { win, q, redraw };
    state.popupFocused = true;
    report('recorder_opened', q.id);
    const watch = setInterval(() => {
      if (!win.closed) return;
      clearInterval(watch);
      if (state.popup?.win === win) state.popup = null;
      state.popupFocused = false;
    }, 500);
  }

  function closeRecorder() {
    if (popupOpen()) state.popup.win.close();
    state.popup = null;
  }

  window.addEventListener('message', async (e) => {
    const p = state.popup;
    if (!p || e.source !== p.win || state.finished) return;
    const m = e.data || {};
    if (m.type === 'recorder-ready') {
      p.win.postMessage({ type: 'recorder-hello', number: p.q.number, prompt: String(p.q.prompt || p.q.title || '').slice(0, 300) }, e.origin);
    } else if (m.type === 'recorder-focus') {
      state.popupFocused = true;
    } else if (m.type === 'recorder-blur') {
      state.popupFocused = false;
      checkFocusSoon('Left the test while the recorder was open');
    } else if (m.type === 'recorder-audio' && typeof m.data === 'string') {
      const { q, redraw } = p;
      state.recordings[q.id] = { uploading: true };
      redraw();
      try {
        if (PREVIEW) {
          state.recordings[q.id] = { id: null, duration: m.duration, localUrl: URL.createObjectURL(base64ToBlob(m.data, m.mime)) };
        } else {
          const r = await call('POST', `/api/my/attempts/${state.attempt.id}/recordings`, {
            clientId: CLIENT_ID,
            questionId: q.id,
            mime: m.mime,
            data: m.data,
            duration: m.duration,
          });
          state.recordings[q.id] = { id: r.id, duration: r.duration };
        }
      } catch (err) {
        delete state.recordings[q.id];
        toast(`The recording was not saved: ${err.message}`, 'error');
      }
      redraw();
      updateProgress();
    }
  });

  function recordWidget(q) {
    if (!state.acc.voiceAnswers) return null;
    const box = h('div', { class: 'record' });
    const draw = () => {
      const r = state.recordings[q.id];
      if (r?.uploading) return clear(box, h('span', { class: 'muted', text: 'Saving your recording…' }));
      const recordBtn = h('button', { class: 'btn btn-record', type: 'button', onclick: () => openRecorder(q, draw) }, r ? '🎤 Record again' : '🎤 Record my answer');
      if (!r) return clear(box, recordBtn);
      clear(
        box,
        h('span', { class: 'ok', text: `✓ Voice answer saved (${fmtDuration(r.duration || 0)})` }),
        r.localUrl ? h('audio', { controls: true, src: r.localUrl }) : recordingPlayer(r.id, 'Listen to my answer'),
        h('div', { class: 'row' }, recordBtn, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => deleteRecording(q, draw) }, 'Delete')),
      );
    };
    draw();
    return box;
  }

  async function deleteRecording(q, draw) {
    const r = state.recordings[q.id];
    if (!r) return;
    try {
      if (!PREVIEW) await call('DELETE', `/api/my/attempts/${state.attempt.id}/recordings/${r.id}`, { clientId: CLIENT_ID });
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
    q.number = number;
    card.append(
      h(
        'div',
        { class: 'q-head' },
        h('span', { class: 'q-num', text: number }),
        h('div', { class: 'q-text' }, q.title ? h('strong', { text: q.title }) : null, h('div', { class: 'prompt', text: q.prompt })),
        h('span', { class: 'q-points', text: `${q.points} pt${q.points === 1 ? '' : 's'}` }),
        listenButton(speakText(q), card),
      ),
    );
    if (q.type === 'mc') {
      card.append(
        h(
          'div',
          { class: 'options', role: 'radiogroup' },
          q.options.map((o, i) =>
            h(
              'label',
              { class: 'option' },
              h('input', { type: 'radio', name: `mc-${q.id}`, value: i, checked: state.answers[q.id] === i, onchange: () => changed(q.id, i) }),
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
    if (rec) card.append(h('div', { class: 'or', text: 'or answer out loud:' }), rec);
    return card;
  }

  function textSizeControls() {
    const sizes = [18, 20, 23, 26, 30];
    let i = 1;
    try {
      i = Math.max(0, Math.min(sizes.length - 1, Number(localStorage.getItem('fs')) || 1));
    } catch (e) {}
    const apply = () => {
      document.documentElement.style.setProperty('--test-fs', `${sizes[i]}px`);
      try {
        localStorage.setItem('fs', i);
      } catch (e) {}
    };
    apply();
    return h(
      'div',
      { class: 'row tight', 'aria-label': 'Text size' },
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => ((i = Math.max(0, i - 1)), apply()), 'aria-label': 'Smaller text' }, 'A−'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => ((i = Math.min(sizes.length - 1, i + 1)), apply()), 'aria-label': 'Bigger text' }, 'A+'),
    );
  }

  function speedControl() {
    if (!state.acc.readAloud || !ttsSupported) return null;
    reader.rate = 0.85;
    return h(
      'select',
      { 'aria-label': 'Reading speed', onchange: (e) => (reader.rate = Number(e.target.value)) },
      [['0.7', 'Slow'], ['0.85', 'A bit slow'], ['1', 'Normal'], ['1.15', 'Fast']].map(([v, l]) => h('option', { value: v, selected: v === '0.85' }, `🔊 ${l}`)),
    );
  }

  function renderTest() {
    const t = state.test;
    timerEl = h('span', { class: 'timer' });
    saveEl = h('span', { class: 'save-status', text: PREVIEW ? 'Preview: nothing is saved' : 'All answers saved' });
    progressEl = h('span', { class: 'progress' });
    let n = 0;
    const instructions = t.instructions
      ? (() => {
          const card = h('section', { class: 'q q-section instructions' });
          card.append(h('div', { class: 'q-head' }, h('h2', { text: 'Instructions' }), listenButton(t.instructions, card)), h('div', { class: 'passage', text: t.instructions }));
          return card;
        })()
      : null;
    clear(
      app,
      PREVIEW
        ? h(
            'div',
            { class: 'preview-banner' },
            'Teacher preview: exam mode is off and nothing is saved. Read-aloud and voice answers are on. ',
            h('a', { href: `#edit/${testId}` }, 'Back to the editor'),
          )
        : null,
      h(
        'header',
        { class: 'test-bar' },
        h('div', { class: 'row tight' }, timerEl, progressEl),
        h('div', { class: 'row tight' }, saveEl, speedControl(), textSizeControls(), h('button', { class: 'btn btn-primary', type: 'button', onclick: confirmSubmit }, 'Submit')),
      ),
      h(
        'main',
        { class: 'test', dir: isRtl(t.language) ? 'rtl' : 'ltr', lang: t.language },
        h('div', { class: 'test-title' }, h('h1', { text: t.title })),
        instructions,
        t.questions.map((q) => questionCard(q, q.type === 'section' ? null : ++n)),
        h('div', { class: 'submit-row' }, h('button', { class: 'btn btn-primary btn-big', type: 'button', onclick: confirmSubmit }, PREVIEW ? 'Submit (preview)' : 'Submit test')),
      ),
    );
    updateProgress();
    tick();
  }

  // ------------------------------------------------------------- submitting

  function confirmSubmit() {
    if (popupOpen()) return toast('Finish or close the recorder window first.', 'warn');
    const missing = answerable().filter((q) => !isAnswered(q)).length;
    modal(
      'Submit your test?',
      h(
        'div',
        {},
        missing ? h('p', { class: 'strong', text: `You have ${missing} unanswered question${missing > 1 ? 's' : ''}.` }) : h('p', { text: 'You answered every question.' }),
        h('p', { text: 'After you submit you cannot change your answers.' }),
      ),
      [['Keep working', null], ['Submit', () => submit('student'), 'btn-primary']],
    );
  }

  async function submit(reason) {
    if (state.finished || state.submitting) return;
    if (PREVIEW) return finish('Preview finished. In a real test the answers would now go to you for grading.');
    state.submitting = true;
    closeRecorder();
    try {
      await api('POST', `/api/my/attempts/${state.attempt.id}/submit`, { clientId: CLIENT_ID, answers: state.answers, reason });
      finish(reason === 'time' ? 'Time is up. Your test was submitted.' : 'Your test was submitted. Well done!');
    } catch (e) {
      state.submitting = false;
      if (e.status === 409) return finish(e.message);
      if (e.status === 423) return showLocked();
      toast(`Could not submit: ${e.message}. Check the internet connection and try again.`, 'error');
    }
  }

  function finish(message) {
    if (state.finished) return;
    state.finished = true;
    intervals.forEach(clearInterval);
    clearInterval(lockPoll);
    reader?.stop();
    closeRecorder();
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
          h('a', { class: 'btn btn-primary btn-big', href: PREVIEW ? `#edit/${testId}` : '#my' }, PREVIEW ? 'Back to the editor' : 'Back to my tests'),
        ),
      ),
    );
  }

  // ----------------------------------------------------------- start screen

  function startScreen(info) {
    const s = state.test.settings;
    const minutes = info.timeLimitMin ? Math.round(info.timeLimitMin * (1 + (info.extraTimePct || 0) / 100)) : 0;
    const rules = [
      minutes ? `You have ${minutes} minutes${info.extraTimePct ? ' (including your extra time)' : ''}. The timer keeps running if you close the page.` : 'There is no time limit.',
      'Your answers save automatically.',
      s.requireFullscreen ? 'The test opens in full screen. Stay in it until you submit.' : null,
      'Leaving the test (another tab, another window or app) is recorded and your teacher sees it.',
      s.maxViolations && s.onLimit === 'lock' ? `If you leave ${s.maxViolations} times, the test is paused until your teacher unlocks it.` : null,
      s.maxViolations && s.onLimit === 'submit' ? `If you leave ${s.maxViolations} times, the test is submitted automatically.` : null,
      s.blockCopyPaste ? 'Copy and paste are turned off.' : null,
      state.acc.readAloud ? 'You can press 🔊 Listen on any question to hear it.' : null,
      state.acc.voiceAnswers ? 'You can answer out loud with 🎤. A small recorder window opens; allow the microphone the first time. Using it does not count as leaving the test.' : null,
    ].filter(Boolean);

    const startBtn = h('button', { class: 'btn btn-primary btn-big', type: 'button' }, info.resuming ? 'Continue the test' : 'Start the test');
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      await enterFullscreen();
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
          { class: 'card start', dir: isRtl(state.test.language) ? 'rtl' : 'ltr' },
          h('h1', { text: state.test.title }),
          h('ul', { class: 'rules' }, rules.map((r) => h('li', { text: r }))),
          h('div', { class: 'row' }, h('a', { class: 'btn btn-ghost', href: '#my' }, 'Back'), startBtn),
        ),
      ),
    );
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

  async function begin() {
    const data = await api('POST', `/api/my/tests/${testId}/start`, { clientId: CLIENT_ID });
    load(data);
    installLockdown();
    renderTest();
    every(tick, 1000);
    every(save, 15000);
    // Notice a teacher pause / end even when the student is idle.
    every(async () => {
      if (state.finished || document.querySelector('.overlay-locked')) return;
      try {
        const s = await api('GET', `/api/my/attempts/${state.attempt.id}/status`);
        state.attempt.deadlineAt = s.deadlineAt;
        state.clockOffset = s.serverNow - Date.now();
        state.violations = s.violations;
        if (s.status === 'locked') showLocked();
        else if (s.status !== 'in_progress') finish('Your test was submitted.');
      } catch (e) {
        // Try again next time.
      }
    }, 30000);
    if (data.attempt.status === 'locked') showLocked();
  }

  // ---------------------------------------------------------------- startup

  (async () => {
    try {
      if (PREVIEW) {
        const { test } = await api('GET', `/api/tests/${testId}/preview`);
        const started = Date.now();
        load({
          test,
          attempt: { id: null, answers: {}, serverNow: started, deadlineAt: test.timeLimitMin ? started + test.timeLimitMin * 60e3 : null },
          accommodations: { readAloud: true, voiceAnswers: true },
        });
        renderTest();
        every(tick, 1000);
        return;
      }
      const { tests } = await api('GET', '/api/my/tests');
      const info = tests.find((t) => String(t.id) === String(testId));
      if (!info) throw new Error('This test is not available to you.');
      if (info.attempt && !['in_progress', 'locked'].includes(info.attempt.status)) return finish('You already submitted this test.');
      const data = await api('GET', `/api/my/tests/${testId}/rules`);
      state.test = data.test;
      state.acc = data.accommodations;
      startScreen({ ...info, resuming: !!info.attempt });
    } catch (e) {
      state.finished = true;
      clear(app, h('main', { class: 'center' }, h('div', { class: 'card narrow' }, h('p', { class: 'error', text: e.message }), h('a', { class: 'btn', href: PREVIEW ? `#edit/${testId}` : '#my' }, 'Back'))));
    }
  })();

  return state;
};
