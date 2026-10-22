'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  role           TEXT    NOT NULL CHECK (role IN ('teacher', 'student')),
  username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT    NOT NULL,
  class_name     TEXT    NOT NULL DEFAULT '',
  pass_hash      TEXT    NOT NULL,
  read_aloud     INTEGER NOT NULL DEFAULT 0,
  voice_answers  INTEGER NOT NULL DEFAULT 0,
  extra_time_pct INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tests (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id),
  title      TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  data       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One attempt per student per test. The test is snapshotted when the student
-- starts, so editing a test later never changes what a student was graded on.
CREATE TABLE IF NOT EXISTS attempts (
  id            INTEGER PRIMARY KEY,
  test_id       INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT    NOT NULL CHECK (status IN ('in_progress', 'locked', 'submitted', 'returned')),
  test_snapshot TEXT    NOT NULL,
  started_at    INTEGER NOT NULL,
  deadline_at   INTEGER,
  submitted_at  INTEGER,
  submit_reason TEXT,
  answers       TEXT    NOT NULL DEFAULT '{}',
  grading       TEXT    NOT NULL DEFAULT '{}',
  feedback      TEXT    NOT NULL DEFAULT '',
  score         REAL,
  max_score     REAL,
  returned_at   INTEGER,
  client_id     TEXT,
  UNIQUE (test_id, student_id)
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL,
  type       TEXT    NOT NULL,
  detail     TEXT    NOT NULL DEFAULT '',
  counted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_attempt ON events (attempt_id);

CREATE TABLE IF NOT EXISTS recordings (
  id          INTEGER PRIMARY KEY,
  attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id TEXT    NOT NULL,
  file        TEXT    NOT NULL,
  mime        TEXT    NOT NULL,
  size        INTEGER NOT NULL,
  duration    REAL,
  created_at  INTEGER NOT NULL,
  UNIQUE (attempt_id, question_id)
);
`;

function open(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'recordings'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'tests.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { open };
