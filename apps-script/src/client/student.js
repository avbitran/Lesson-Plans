// The student's home page and their returned results.

(function () {
  const app = () => document.getElementById('app');

  function statusCell(t) {
    const a = t.attempt;
    if (!a) return t.testOpen ? h('a', { class: 'btn btn-primary', href: `#take/${t.id}` }, 'Start') : h('span', { class: 'muted', text: 'Closed' });
    if (a.status === 'in_progress') return h('a', { class: 'btn btn-primary', href: `#take/${t.id}` }, 'Continue');
    if (a.status === 'locked') return h('a', { class: 'btn', href: `#take/${t.id}` }, 'Paused — ask your teacher');
    if (a.status === 'submitted') return h('span', { class: 'badge', text: `Submitted ${fmtDate(a.submittedAt)} · waiting for grading` });
    return h(
      'div',
      { class: 'row tight' },
      a.score !== null ? h('span', { class: 'badge badge-ok', text: `${a.score} / ${a.maxScore}` }) : h('span', { class: 'badge', text: 'Graded' }),
      a.score !== null ? h('a', { class: 'btn', href: `#result/${a.id}` }, a.hasDetails ? 'See my answers' : 'See feedback') : null,
    );
  }

  // Joining a class with the code the teacher gives out. Google already knows
  // the student's school email, so a name is all they type.
  function joinForm({ firstTime }) {
    const code = h('input', { class: 'join-input', placeholder: 'ENG-4821', autocomplete: 'off', 'aria-label': 'Class code' });
    const name = firstTime ? h('input', { placeholder: 'First and last name', autocomplete: 'name', 'aria-label': 'Your full name' }) : null;
    const error = h('p', { class: 'error', role: 'alert' });
    const btn = h('button', { class: 'btn btn-primary btn-big', type: 'submit' }, 'Join the class');
    return h(
      'form',
      {
        class: 'form',
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = '';
          btn.disabled = true;
          try {
            const r = await api('POST', '/api/join', { code: code.value, name: name ? name.value : '' });
            if (firstTime) Object.assign(BOOT.user, { role: 'student', name: name.value.trim() || BOOT.user.email.split('@')[0] });
            toast(r.status === 'pending' ? `Asked to join ${r.className}. Your teacher needs to approve you.` : `You joined ${r.className}.`, 'ok');
            location.hash = '#my';
            App.route();
          } catch (err) {
            error.textContent = err.message;
            btn.disabled = false;
          }
        },
      },
      h('label', {}, 'Class code (from your teacher)', code),
      name ? h('label', {}, 'Your full name', name) : null,
      error,
      btn,
    );
  }

  App.joinPage = function () {
    clear(
      app(),
      h(
        'main',
        { class: 'center' },
        h(
          'div',
          { class: 'card join-card' },
          h('h1', { text: 'Online Tests' }),
          h('p', {}, 'You are signed in as ', h('strong', { text: BOOT.user.email }), '. To start, join your class with the code your teacher gives you.'),
          joinForm({ firstTime: true }),
          h('p', { class: 'small muted', text: 'No code? Ask your teacher to add this email to the class.' }),
        ),
      ),
    );
  };

  async function list() {
    const { tests, classes = [] } = await api('GET', '/api/my/tests');
    const pending = classes.filter((c) => c.status === 'pending');
    clear(
      app(),
      header(),
      h(
        'main',
        { class: 'wrap' },
        h('h1', { text: `Hi ${BOOT.user.name}` }),
        pending.length ? h('p', { class: 'card', text: `Waiting for your teacher to let you into ${pending.map((c) => c.name).join(', ')}. Check again later.` }) : null,
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
                  statusCell(t),
                ),
              ),
            )
          : h('p', { class: 'muted', text: 'No tests for you right now.' }),
        h('details', { class: 'card join-more' }, h('summary', { text: 'Join another class' }), joinForm({ firstTime: false })),
      ),
    );
  }

  function answerText(q, a) {
    if (a === undefined || a === null || a === '' || (Array.isArray(a) && !a.length)) return '—';
    if (q.type === 'mc') return optionText(q, a);
    if (q.type === 'match') return q.pairs.map((p, k) => `${Number.isInteger(a[k]) ? a[k] + 1 : '–'} → ${p.text}`).join('\n');
    return a;
  }

  async function result(id) {
    const r = await api('GET', `/api/my/attempts/${id}/result`);
    let n = 0;
    const recs = Object.fromEntries((r.recordings || []).map((x) => [x.questionId, x]));
    clear(
      app(),
      header([['← My tests', '#my']]),
      h(
        'main',
        { class: 'wrap', dir: r.test && isRtl(r.test.language) ? 'rtl' : 'ltr' },
        h('h1', { text: r.title }),
        h('p', { class: 'score-big', text: `${r.score} / ${r.maxScore}` }),
        r.feedback ? h('div', { class: 'card feedback' }, h('h2', { text: 'Feedback from your teacher' }), h('p', { class: 'pre', text: r.feedback })) : null,
        r.mode === 'full'
          ? r.test.questions.map((q) => {
              if (q.type === 'section') return h('section', { class: 'q q-section' }, q.title ? h('h2', { text: q.title }) : null, h('div', { class: 'passage', text: q.prompt }));
              const m = r.marks[q.id] || {};
              const right = m.points === m.max;
              return h(
                'section',
                { class: `q ${right ? 'q-right' : 'q-wrong'}` },
                h(
                  'div',
                  { class: 'q-head' },
                  h('span', { class: 'q-num', text: ++n }),
                  h('div', { class: 'q-text' }, q.title ? h('strong', { text: q.title }) : null, h('div', { class: 'prompt', text: q.prompt })),
                  h('span', { class: 'q-points', text: `${m.points ?? '–'} / ${m.max}` }),
                ),
                h('p', {}, h('span', { class: 'muted', text: 'Your answer: ' }), h('span', { class: 'pre', text: answerText(q, r.answers[q.id]) })),
                recs[q.id] ? recordingPlayer(recs[q.id].id, 'Listen to my answer') : null,
                !right && q.type === 'mc' ? h('p', { class: 'ok', text: `Correct answer${q.multiple ? 's' : ''}: ${optionText(q, q.correct)}` }) : null,
                !right && q.type === 'short' && q.accepted?.length ? h('p', { class: 'ok', text: `Correct answer: ${q.accepted[0]}` }) : null,
                !right && q.type === 'match' ? h('p', { class: 'ok pre', text: `Correct: ${q.pairs.map((p) => `${p.answer + 1} → ${p.text}`).join('\n')}` }) : null,
                m.comment ? h('p', { class: 'comment', text: `💬 ${m.comment}` }) : null,
              );
            })
          : null,
      ),
    );
  }

  App.studentRoute = async function (name, arg) {
    try {
      if (name === 'take') return App.take(arg);
      if (name === 'result') return await result(arg);
      await list();
    } catch (e) {
      clear(app(), header(), h('main', { class: 'wrap' }, h('p', { class: 'error', text: e.message })));
    }
  };
})();
