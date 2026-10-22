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

  async function list() {
    const { tests } = await api('GET', '/api/my/tests');
    clear(
      app(),
      header(),
      h(
        'main',
        { class: 'wrap' },
        h('h1', { text: `Hi ${BOOT.user.name}` }),
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
      ),
    );
  }

  function answerText(q, a) {
    if (a === undefined || a === null || a === '') return '—';
    if (q.type === 'mc') return `${LETTERS[a]}. ${q.options[a]}`;
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
                !right && q.type === 'mc' ? h('p', { class: 'ok', text: `Correct answer: ${LETTERS[q.correct]}. ${q.options[q.correct]}` }) : null,
                !right && q.type === 'short' && q.accepted?.length ? h('p', { class: 'ok', text: `Correct answer: ${q.accepted[0]}` }) : null,
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
