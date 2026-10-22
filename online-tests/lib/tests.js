'use strict';
// Test definitions: validation, the student-safe view, and auto-grading.

const QUESTION_TYPES = ['section', 'mc', 'short', 'long'];
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
      out.correct = int(q.correct, 0, out.options.length - 1, 0);
    }
    if (type === 'short') {
      out.accepted = (Array.isArray(q.accepted) ? q.accepted : [])
        .map((a) => str(a, 500).trim())
        .filter(Boolean)
        .slice(0, 30);
    }
    if (type === 'long') out.modelAnswer = str(q.modelAnswer, 5000);
    if (!out.prompt.trim() && !out.title.trim()) throw new ValidationError(`Question ${i + 1} has no text.`);
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
    },
    questions,
  };
}

// What a student's browser gets: no correct answers, no model answers.
function studentView(test) {
  return {
    ...test,
    questions: test.questions.map(({ correct, accepted, modelAnswer, ...rest }) => rest),
  };
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
    const empty = a === undefined || a === null || (typeof a === 'string' && !a.trim());
    let auto = null;
    let review = true;
    if (q.type === 'mc' && Number.isInteger(a)) {
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

module.exports = {
  ValidationError,
  normalizeTest,
  studentView,
  maxScore,
  normalizeAnswer,
  autoGrade,
  totalScore,
  LANGUAGES,
};
