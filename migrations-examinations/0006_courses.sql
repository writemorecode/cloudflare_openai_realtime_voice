PRAGMA foreign_keys = ON;

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  created_by_user_id INTEGER NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  code TEXT CHECK (code IS NULL OR length(code) BETWEEN 1 AND 40),
  description TEXT CHECK (description IS NULL OR length(description) <= 4000),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX courses_created_at_idx ON courses(created_at DESC);

ALTER TABLE examinations
  ADD COLUMN course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE RESTRICT;

CREATE INDEX examinations_course_created_idx ON examinations(course_id, created_at DESC);
