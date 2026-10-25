// Test definitions: validation, the student-safe view, and auto-grading.

const QUESTION_TYPES = ['section', 'mc', 'short', 'long', 'blanks', 'match'];
const VOICE_PROVIDERS = ['browser', 'google', 'chatterbox'];
const MAX_BLANKS = 80;

// Fill in the blanks: each answer sits in {curly braces} inside the text,
// alternatives split by | ("{to play|playing}"). Empty braces {} are a blank
// the teacher marks.
const BLANK_RE = /\{([^{}]*)\}/g;
function parseBlanks(prompt) {
  const out = [];
  String(prompt || '').replace(BLANK_RE, (_, inner) => {
    out.push(inner.split('|').map((x) => x.trim()).filter(Boolean));
    return '';
  });
  return out;
}

// The order students see matching choices in: shuffled, but the same every
// time for a given question, so read-aloud audio and saved answers line up.
function seededShuffle(list, seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    const j = ((h ^ (h >>> 16)) >>> 0) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function matchChoices(q) {
  return [...new Set(q.pairs.map((p) => p.right).concat(q.extra || []))];
}
const LANGUAGES = ['en-US', 'en-GB', 'he-IL', 'ar-SA', 'ru-RU', 'fr-FR', 'es-ES', 'de-DE'];
const ON_LIMIT = ['log', 'lock', 'submit'];
const SHOW_RESULTS = ['none', 'score', 'full'];

class ValidationError extends Error {}

const str = (v, max) => String(v ?? '').slice(0, max);
const int = (v, min, max, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const num = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

function normalizeTest(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('Test data is missing.');
  const title = str(input.title, 200).trim();
  if (!title) throw new ValidationError('The test needs a title.');
  if (!Array.isArray(input.questions)) throw new ValidationError('The test has no questions list.');
  if (input.questions.length > 300) throw new ValidationError('A test can have at most 300 items.');

  const s = input.settings || {};
  const seen = new Set();
  const questions = input.questions.map((q, i) => {
    const type = QUESTION_TYPES.includes(q?.type) ? q.type : null;
    if (!type) throw new ValidationError(`Item ${i + 1} has an unknown type.`);
    let id = str(q.id, 40).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id || seen.has(id)) id = `q${i + 1}_${Math.random().toString(36).slice(2, 7)}`;
    seen.add(id);
    const out = { id, type, title: str(q.title, 300), prompt: str(q.prompt, 20000) };
    if (type === 'section') return out;
    out.points = num(q.points, 0, 1000, 1);
    if (type === 'mc') {
      const options = (Array.isArray(q.options) ? q.options : []).map((o) => str(o, 1000)).filter((o) => o.trim());
      if (options.length < 2) throw new ValidationError(`Question ${i + 1} needs at least two options.`);
      out.options = options.slice(0, 12);
      if (q.multiple) {
        // "Choose the TWO correct answers": several options are right.
        const picks = (Array.isArray(q.correct) ? q.correct : [q.correct])
          .map((c) => parseInt(c, 10))
          .filter((c) => Number.isInteger(c) && c >= 0 && c < out.options.length);
        out.multiple = true;
        out.correct = [...new Set(picks)].sort((a, b) => a - b);
        if (!out.correct.length) throw new ValidationError(`Question ${i + 1}: mark at least one correct answer.`);
        out.scoring = q.scoring === 'all' ? 'all' : 'partial';
      } else {
        out.correct = int(Array.isArray(q.correct) ? q.correct[0] : q.correct, 0, out.options.length - 1, 0);
      }
    }
    if (type === 'short') {
      out.accepted = (Array.isArray(q.accepted) ? q.accepted : [])
        .map((a) => str(a, 500).trim())
        .filter(Boolean)
        .slice(0, 30);
    }
    if (type === 'long') out.modelAnswer = str(q.modelAnswer, 5000);
    if (type === 'blanks') {
      const n = parseBlanks(out.prompt).length;
      if (!n) throw new ValidationError(`Question ${i + 1}: put each answer in {curly braces}, e.g. "She opened a small {business}."`);
      if (n > MAX_BLANKS) throw new ValidationError(`Question ${i + 1} has more than ${MAX_BLANKS} blanks. Split it into two questions.`);
      out.wordBank = (Array.isArray(q.wordBank) ? q.wordBank : [])
        .map((w) => str(w, 200).trim())
        .filter(Boolean)
        .slice(0, 60);
      out.dropdown = !!q.dropdown && out.wordBank.length > 0;
    }
    if (type === 'match') {
      out.pairs = (Array.isArray(q.pairs) ? q.pairs : [])
        .map((p) => ({ left: str(p && p.left, 500).trim(), right: str(p && p.right, 500).trim() }))
        .filter((p) => p.left && p.right)
        .slice(0, 40);
      if (out.pairs.length < 2) throw new ValidationError(`Question ${i + 1} needs at least two pairs to match.`);
      out.extra = (Array.isArray(q.extra) ? q.extra : [])
        .map((x) => str(x, 500).trim())
        .filter(Boolean)
        .slice(0, 10);
    }
    if (!out.prompt.trim() && !out.title.trim() && type !== 'match') throw new ValidationError(`Question ${i + 1} has no text.`);
    return out;
  });

  return {
    title,
    instructions: str(input.instructions, 5000),
    language: LANGUAGES.includes(input.language) ? input.language : 'en-US',
    timeLimitMin: int(input.timeLimitMin, 0, 600, 0),
    classes: (Array.isArray(input.classes) ? input.classes : [])
      .map((c) => str(c, 60).trim())
      .filter(Boolean)
      .slice(0, 50),
    settings: {
      requireFullscreen: s.requireFullscreen !== false,
      maxViolations: int(s.maxViolations, 0, 50, 3),
      onLimit: ON_LIMIT.includes(s.onLimit) ? s.onLimit : 'lock',
      blockCopyPaste: s.blockCopyPaste !== false,
      readAloudForAll: !!s.readAloudForAll,
      recordingForAll: !!s.recordingForAll,
      showResults: SHOW_RESULTS.includes(s.showResults) ? s.showResults : 'score',
      voice: {
        provider: VOICE_PROVIDERS.includes(s.voice && s.voice.provider) ? s.voice.provider : 'browser',
        name: str(s.voice && s.voice.name, 100).trim(),
      },
    },
    questions,
  };
}

// What a student's browser gets: no correct answers, no model answers.
// Every item also carries `speech`, the exact text read aloud, and `audio`,
// the id of prepared natural-voice audio for it (null: use the device voice).
// audioFor(text) looks that id up; it's optional.
function studentView(test, audioFor) {
  const find = audioFor || (() => null);
  const questions = test.questions.map(({ correct, accepted, modelAnswer, scoring, pairs, extra, ...rest }) => {
    const q = { ...rest };
    if (rest.multiple) q.choose = correct.length;
    if (rest.type === 'blanks') {
      q.prompt = rest.prompt.replace(BLANK_RE, '{}');
      q.blankCount = parseBlanks(rest.prompt).length;
    }
    if (rest.type === 'match') {
      q.left = pairs.map((p) => p.left);
      q.right = seededShuffle(matchChoices({ pairs, extra }), rest.id);
    }
    q.speech = speechText(q);
    q.audio = find(q.speech);
    return q;
  });
  const instructionsSpeech = sentence(test.instructions);
  return { ...test, questions, instructionsSpeech, instructionsAudio: instructionsSpeech ? find(instructionsSpeech) : null };
}

// Ends a piece of text with punctuation so voices pause naturally.
function sentence(s) {
  const t = String(s || '').trim();
  return !t || /[.!?:;…"'”)\]]$/.test(t) ? t : `${t}.`;
}

const LETTERS_ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// "a small ___ selling" is read as "a small … blank … selling".
const blankWords = (s) =>
  String(s || '')
    .replace(/\s*_{2,}\s*/g, ' … blank … ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([.,!?;:])/g, '$1')
    .trim();

// What 🔊 Listen reads for one item (given the student version of it).
function speechText(q) {
  const parts = [sentence(q.title)];
  if (q.type === 'blanks') {
    if (q.wordBank && q.wordBank.length) parts.push(sentence(`The words are: ${q.wordBank.join(', ')}`));
    for (const line of q.prompt.split('\n')) parts.push(sentence(blankWords(line.replace(/\{\}/g, '___'))));
  } else if (q.type === 'match') {
    parts.push(sentence(q.prompt));
    q.left.forEach((l, i) => parts.push(sentence(`${i + 1}: ${l}`)));
    parts.push('The choices are:');
    q.right.forEach((r, i) => parts.push(sentence(`${LETTERS_[i]}: ${r}`)));
  } else {
    parts.push(sentence(blankWords(q.prompt)));
    if (q.multiple) parts.push(`Choose ${q.choose} answers.`);
    if (q.type === 'mc') q.options.forEach((o, i) => parts.push(sentence(`${LETTERS_[i]}: ${o}`)));
  }
  return parts.filter(Boolean).join('\n');
}

// Splits text for a speech service: by language (Hebrew and Arabic stretches
// get their own voice) and into pieces of at most maxLen characters, cut at
// sentence ends where possible.
function ttsPieces(text, lang, maxLen) {
  const scriptOf = (s) => (/[֐-׿]/.test(s) ? 'he-IL' : /[؀-ۿ]/.test(s) ? 'ar-SA' : null);
  const sentences = String(text || '')
    .split(/(?<=[.!?;:…])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const pieces = [];
  for (let sen of sentences) {
    const l = scriptOf(sen) || lang;
    while (sen.length > maxLen) {
      const cut = sen.lastIndexOf(' ', maxLen) > maxLen / 2 ? sen.lastIndexOf(' ', maxLen) : maxLen;
      pieces.push({ text: sen.slice(0, cut).trim(), lang: l });
      sen = sen.slice(cut).trim();
    }
    const last = pieces[pieces.length - 1];
    if (last && last.lang === l && last.text.length + sen.length + 1 <= maxLen) last.text += ` ${sen}`;
    else if (sen) pieces.push({ text: sen, lang: l });
  }
  return pieces;
}

function maxScore(test) {
  return test.questions.reduce((sum, q) => sum + (q.type === 'section' ? 0 : q.points), 0);
}

// Typing differences that shouldn't cost a point: case, spacing, curly
// apostrophes, a trailing full stop.
function normalizeAnswer(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '')
    .trim();
}

/**
 * Per-question automatic marks.
 * auto: points awarded automatically, or null when only the teacher can mark it.
 * review: true when the teacher should look (manual items, voice answers,
 *         short answers that matched nothing in the accepted list).
 */
function autoGrade(test, answers, recordedQuestionIds) {
  const result = {};
  for (const q of test.questions) {
    if (q.type === 'section') continue;
    const a = answers[q.id];
    const recorded = recordedQuestionIds.has(q.id);
    const empty =
      a === undefined || a === null || (typeof a === 'string' && !a.trim()) || (Array.isArray(a) && !a.some((x) => (typeof x === 'string' ? x.trim() : x !== null && x !== undefined)));
    let auto = null;
    let review = true;
    const emptyList = Array.isArray(a) && !a.some((x) => (typeof x === 'string' ? x.trim() : x !== null && x !== undefined));
    if ((q.type === 'blanks' || q.type === 'match') && Array.isArray(a) && !emptyList) {
      const g = q.type === 'blanks' ? gradeBlanks(q, a) : gradeMatch(q, a);
      auto = g.auto;
      review = g.review || recorded;
    } else if (q.type === 'mc' && q.multiple && Array.isArray(a) && a.length) {
      auto = scoreMultiple(q, a);
      review = recorded;
    } else if (q.type === 'mc' && !q.multiple && Number.isInteger(a)) {
      auto = a === q.correct ? q.points : 0;
      review = recorded;
    } else if (q.type === 'short' && !empty) {
      const ok = q.accepted.some((acc) => normalizeAnswer(acc) === normalizeAnswer(a));
      auto = ok ? q.points : 0;
      review = !ok || recorded;
    } else if (empty && !recorded) {
      auto = 0;
      review = false;
    }
    result[q.id] = { auto, review, max: q.points };
  }
  return result;
}

const share = (points, hits, total) => Math.round((points * hits * 100) / total) / 100;

// Each blank is worth an equal share. A blank with no accepted answers, or an
// answer that matched none, is left for the teacher to check.
function gradeBlanks(q, a) {
  const keys = parseBlanks(q.prompt);
  let hits = 0;
  let review = false;
  keys.forEach((accepted, i) => {
    const given = typeof a[i] === 'string' ? a[i] : '';
    if (!accepted.length) {
      if (given.trim()) review = true;
      return;
    }
    if (accepted.some((acc) => normalizeAnswer(acc) === normalizeAnswer(given))) hits++;
    else if (given.trim()) review = true;
  });
  return { auto: share(q.points, hits, keys.length), review };
}

function gradeMatch(q, a) {
  const hits = q.pairs.filter((p, i) => typeof a[i] === 'string' && normalizeAnswer(a[i]) === normalizeAnswer(p.right)).length;
  return { auto: share(q.points, hits, q.pairs.length), review: false };
}

// Partial: an equal share of the points for each correct option chosen
// (choosing more options than allowed scores nothing). All: everything right
// or zero.
function scoreMultiple(q, picks) {
  const chosen = [...new Set(picks)];
  if (chosen.length > q.correct.length) return 0;
  const hits = chosen.filter((c) => q.correct.includes(c)).length;
  if (q.scoring === 'all') return hits === q.correct.length ? q.points : 0;
  return Math.round((q.points * hits * 100) / q.correct.length) / 100;
}

// Teacher marks win; otherwise the automatic mark; otherwise nothing yet.
function totalScore(test, auto, grading) {
  let total = 0;
  for (const q of test.questions) {
    if (q.type === 'section') continue;
    const g = grading[q.id];
    const pts = g && Number.isFinite(g.points) ? g.points : auto[q.id]?.auto;
    total += Number.isFinite(pts) ? pts : 0;
  }
  return Math.round(total * 100) / 100;
}

if (typeof module !== 'undefined') {
  module.exports = {
    ValidationError, normalizeTest, studentView, maxScore, normalizeAnswer, autoGrade, totalScore, LANGUAGES,
    parseBlanks, matchChoices, seededShuffle, speechText, ttsPieces, sentence, VOICE_PROVIDERS,
  };
}
