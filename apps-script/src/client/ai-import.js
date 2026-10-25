// "Create from PDF with AI": the teacher gives a PDF or Word file and these instructions
// to any AI chat (Claude, Gemini, ChatGPT), pastes the reply back, and gets a
// draft test to check. No API key or cost involved.

(function () {
  const AI_PROMPT = `Turn the attached test (PDF or Word document) into JSON for an online test system. Reply with ONLY the JSON, in one code block.

FORMAT
{
  "title": "test title",
  "instructions": "general instructions for students (may be empty)",
  "language": "en-US",
  "timeLimitMin": 0,
  "questions": [ ...items in the same order as the test... ]
}

ITEM TYPES
1. Text students read (a reading passage, a part heading, instructions for a whole part):
   {"type": "section", "title": "Part A", "prompt": "the full text, exactly as written"}
2. Multiple choice, one correct answer (options are counted from 0):
   {"type": "mc", "prompt": "question", "options": ["...", "...", "...", "..."], "correct": 2, "points": 4}
3. Multiple choice with several correct answers ("Choose TWO correct answers"):
   {"type": "mc", "multiple": true, "prompt": "question", "options": ["...", "...", "...", "...", "..."], "correct": [0, 3], "points": 6}
4. Fill in the blanks: one or more sentences with gaps. Write the sentences in "prompt", one per line ("\\n"), and put the answer for each gap inside {curly braces} where the gap is. Several acceptable answers: {to play|playing}. A gap only the teacher can mark (a translation, a free answer): {}. A sentence with two gaps has two {…}. If the exercise has a word bank (a box or list of words to use), copy it into "wordBank" and leave it out of the prompt:
   {"type": "blanks", "title": "Complete the sentences with the words below.", "wordBank": ["business", "protection"], "prompt": "She opened a small {business} selling jewelry online.\\nA helmet gives you basic {protection}.", "points": 2}
5. Matching ("match the words to their definitions", "match the halves"): each item with its correct match. Matches that belong to no item go in "extra". Students see the matches mixed up:
   {"type": "match", "prompt": "Match the words to their definitions.", "pairs": [{"left": "Unique", "right": "special"}, {"left": "Repair", "right": "to fix"}], "extra": [], "points": 2}
6. Short answer with a few acceptable answers (one word, a verb form, a number):
   {"type": "short", "prompt": "question", "accepted": ["answer", "another acceptable answer"], "points": 3}
7. Open answer the teacher marks (sentences, explanations, translating a whole sentence):
   {"type": "long", "prompt": "question", "modelAnswer": "a good answer and what to look for", "points": 8}

CHOOSING THE TYPE
- Gaps in sentences (with or without a word bank, one or several gaps per sentence): "blanks". Put all the sentences of one exercise in ONE blanks item, one per line, unless they need different points. Write the sentence in "prompt" without its number.
- A pair of words for each sentence ("complete using the pair of words"): "blanks" with two {…} in that sentence, and every word of every pair in "wordBank".
- Verb-form gaps ("complete with the correct form of the verb", "-ing or to"): "blanks", with every correct form in the braces: {waking up|to wake up}.
- "Translate the words AND match them to their definitions": two items. A "blanks" item for the translations (one word per line, "Unique {}"), then a "match" item for the definitions.
- Translating sentences (e.g. from Hebrew into English): one "long" item per sentence. Copy the sentence exactly in its own language (Hebrew stays in Hebrew) and give a model answer.
- An exercise in a table or two columns: read it in the order a student would and use the type that fits.

RULES
- Copy every passage, question, option and word for word. Don't shorten, fix or translate anything. Keep Hebrew, Arabic or any other language exactly as written. Keep line or paragraph numbers in passages if the questions refer to them.
- Keep the test's own point values. If none are given, use 1 point per blank, per pair, per multiple-choice question and per short answer, and 4 points per open answer.
- Put each passage in a "section" item right before its questions. Put a part's heading ("Part 2 - LANGUAGE FOCUS") in a "section" item too.
- For answers ("correct", "accepted", the {braces}, "pairs" and "modelAnswer"): use the answer key if the document has one. Otherwise work out the correct answers yourself, and start modelAnswer with "CHECK:" for open questions.
- If a question has parts (i, ii, iii), make each part its own item.
- Pictures, charts and tables you can't turn into items: describe them briefly in [square brackets] inside the nearest text.
- Leave out the name line, cover pages, page numbers and "good luck" lines. Don't leave out any exercise.`;

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
      'Create a test from a PDF or Word file',
      h(
        'div',
        { class: 'form' },
        step(1, 'Copy these instructions', promptBox, h('div', {}, h('button', { class: 'btn', type: 'button', autofocus: true, onclick: () => copyText(promptBox) }, '📋 Copy instructions'))),
        step(
          2,
          'Give the AI the file and the instructions',
          h(
            'p',
            {},
            'Open an AI chat (',
            link('https://claude.ai/new', 'Claude'),
            ', ',
            link('https://gemini.google.com/app', 'Gemini'),
            ' or ',
            link('https://chatgpt.com/', 'ChatGPT'),
            '), attach the PDF or Word file with the 📎 button, paste the instructions, and send. Long exams may take a minute.',
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
