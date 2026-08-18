PRAGMA foreign_keys = ON;

CREATE TABLE transcription_jobs_new (
  id TEXT PRIMARY KEY,
  examination_session_id TEXT NOT NULL REFERENCES examination_sessions(id) ON DELETE CASCADE,
  source_object_key TEXT NOT NULL,
  source_etag TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'complete', 'failed')
  ),
  transcript_key TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  enqueue_attempts INTEGER NOT NULL DEFAULT 0,
  last_enqueue_attempt_at INTEGER,
  UNIQUE (source_object_key, source_etag)
);

INSERT INTO transcription_jobs_new (
  id,
  examination_session_id,
  source_object_key,
  source_etag,
  model,
  status,
  transcript_key,
  error_code,
  created_at,
  started_at,
  completed_at,
  enqueue_attempts,
  last_enqueue_attempt_at
)
SELECT
  id,
  examination_session_id,
  source_object_key,
  source_etag,
  model,
  status,
  transcript_json_key,
  error_code,
  created_at,
  started_at,
  completed_at,
  enqueue_attempts,
  last_enqueue_attempt_at
FROM transcription_jobs;

DROP TABLE transcription_jobs;
ALTER TABLE transcription_jobs_new RENAME TO transcription_jobs;

CREATE INDEX transcription_jobs_session_created_idx
  ON transcription_jobs(examination_session_id, created_at DESC);

CREATE INDEX transcription_jobs_status_created_idx
  ON transcription_jobs(status, created_at);

CREATE INDEX transcription_jobs_dispatch_idx
  ON transcription_jobs(status, last_enqueue_attempt_at);
