// "Create from PDF with AI": the teacher gives a PDF and these instructions
// to any AI chat (Claude, Gemini, ChatGPT), pastes the reply back, and gets a
// draft test to check. No API key or cost involved.

(function () {
  const AI_PROMPT = `Turn the attached test (PDF) into JSON for an online test system. Reply with ONLY the JSON, in one code block.

FORMAT
{
  "title": "test title",
  "instructions": "general instructions for students (may be empty)",
  "language": "en-US",
  "timeLimitMin": 0,
  "questions": [ ...items in the same order as the test... ]
}

ITEM TYPES
1. Text students read (a reading passage, a part heading, instructions for a part):
   {"type": "section", "title": "Part A", "prompt": "the full text, exactly as written"}
2. Multiple choice, one correct answer (options are counted from 0):
   {"type": "mc", "prompt": "question", "options": ["...", "...", "...", "..."], "correct": 2, "points": 4}
3. Multiple choice with several correct answers ("Choose TWO correct answers"):
   {"type": "mc", "multiple": true, "prompt": "question", "options": ["...", "...", "...", "...", "..."], "correct": [0, 3], "points": 6}
4. Short answer with a few acceptable answers (a word, a verb form, a number):
   {"type": "short", "prompt": "question", "accepted": ["answer", "another acceptable answer"], "points": 3}
5. Matching (vocabulary: match items to definitions; extra items are distractors; "answer" is the item's position counted from 0):
   {"type": "match", "prompt": "the instructions", "items": ["a calendar", "a season", "an island", "traffic", "a prize", "a label"], "pairs": [{"text": "cars, buses, and trucks moving along a road", "answer": 3}, {"text": "shows days, weeks, and months in a year", "answer": 0}], "pointsEach": 2}
   Leave out the worked example the test shows; include only the definitions students must answer.
6. Open answer the teacher marks (sentences, explanations, "complete the sentence" with free wording):
   {"type": "long", "prompt": "question", "modelAnswer": "a good answer and what to look for", "points": 8}

RULES
- Copy every passage, question and option word for word. Don't shorten, fix or translate anything. Keep line numbers in passages if the test refers to them (for example "lines 12-15").
- Keep the test's own point values. If none are given, use 1 point per question.
- Put each passage in a "section" item right before its questions.
- For "correct", "accepted" and "modelAnswer": use the answer key if the PDF has one. Otherwise give your best answer and start modelAnswer with "CHECK:" for open questions.
- If a question has parts (i, ii, iii), make each part its own item.
- Pictures, charts and tables can't be shown: describe them briefly in [square brackets] inside the nearest text.
- Leave out cover pages, page numbers, and "good luck" lines.`;

  // Accepts the reply with or without a code block or text around it.
  function extractJson(text) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('No test found in what you pasted. Paste the AI’s whole reply.');
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch (e) {
      throw new Error('The pasted text is not complete JSON. If the AI’s reply was cut off, ask it to "continue", then paste the whole thing.');
    }
  }

  function copyText(ta) {
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {}
    toast(ok ? 'Copied. Now paste it into the AI chat.' : 'Select the text and press Ctrl+C to copy it.', ok ? 'ok' : 'warn');
  }

  App.aiImport = function () {
    const promptBox = h('textarea', { rows: 6, readonly: true, value: AI_PROMPT, class: 'mono-small' });
    const reply = h('textarea', { rows: 8, placeholder: 'Paste the AI’s whole reply here' });
    const step = (n, title, ...body) => h('div', { class: 'ai-step' }, h('h3', {}, h('span', { class: 'q-num', text: n }), ' ', title), ...body);
    const link = (href, label) => h('a', { href, target: '_blank', rel: 'noopener' }, label);
    modal(
      'Create a test from a PDF',
      h(
        'div',
        { class: 'form' },
        step(1, 'Copy these instructions', promptBox, h('div', {}, h('button', { class: 'btn', type: 'button', autofocus: true, onclick: () => copyText(promptBox) }, '📋 Copy instructions'))),
        step(
          2,
          'Give the AI the PDF and the instructions',
          h(
            'p',
            {},
            'Open an AI chat (',
            link('https://claude.ai/new', 'Claude'),
            ', ',
            link('https://gemini.google.com/app', 'Gemini'),
            ' or ',
            link('https://chatgpt.com/', 'ChatGPT'),
            '), attach the PDF with the 📎 button, paste the instructions, and send. Long exams may take a minute.',
          ),
        ),
        step(3, 'Paste the AI’s reply', reply),
        h('p', { class: 'muted small', text: 'The test opens as a draft. AI makes mistakes, especially with answer keys, so check every question, option and correct answer before opening it to students.' }),
      ),
      [
        ['Cancel', null],
        [
          'Create draft',
          async () => {
            try {
              const data = extractJson(reply.value);
              const { id } = await api('POST', '/api/tests', { data });
              toast('Draft created. Check it carefully before opening it.', 'ok');
              location.hash = `#edit/${id}`;
            } catch (e) {
              toast(e.message, 'error');
              return false;
            }
          },
          'btn-primary',
        ],
      ],
    );
  };
})();
