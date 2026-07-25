PRAGMA foreign_keys = ON;

CREATE TABLE examinations (
  id TEXT PRIMARY KEY,
  created_by_user_id INTEGER NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 160),
  created_at INTEGER NOT NULL
);

CREATE INDEX examinations_created_at_idx ON examinations(created_at DESC);

CREATE TABLE examination_questions (
  id TEXT PRIMARY KEY,
  examination_id TEXT NOT NULL REFERENCES examinations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  UNIQUE (examination_id, ordinal)
);

CREATE INDEX examination_questions_examination_idx
  ON examination_questions(examination_id, ordinal);

CREATE TABLE examination_sessions (
  id TEXT PRIMARY KEY,
  examination_id TEXT NOT NULL REFERENCES examinations(id),
  user_id INTEGER NOT NULL,
  conversation_id TEXT NOT NULL UNIQUE,
  question_state TEXT NOT NULL CHECK (
    question_state IN ('in_progress', 'complete')
  ),
  current_question_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (current_question_ordinal >= 1),
  question_revision INTEGER NOT NULL DEFAULT 0 CHECK (question_revision >= 0),
  created_at INTEGER NOT NULL,
  questions_completed_at INTEGER
);

CREATE INDEX examination_sessions_user_created_idx
  ON examination_sessions(user_id, created_at DESC);

CREATE INDEX examination_sessions_examination_idx
  ON examination_sessions(examination_id, created_at DESC);

CREATE TABLE examination_question_completions (
  session_id TEXT NOT NULL REFERENCES examination_sessions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES examination_questions(id),
  disposition TEXT NOT NULL CHECK (
    disposition IN ('answered', 'answered_after_follow_up', 'unable_to_answer')
  ),
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, question_id)
);

CREATE INDEX examination_question_completions_question_idx
  ON examination_question_completions(question_id);
