PRAGMA foreign_keys = ON;

CREATE TABLE transcription_jobs (
  id TEXT PRIMARY KEY,
  examination_session_id TEXT NOT NULL REFERENCES examination_sessions(id) ON DELETE CASCADE,
  source_object_key TEXT NOT NULL,
  source_etag TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'complete', 'failed')
  ),
  transcript_json_key TEXT,
  transcript_vtt_key TEXT,
  transcript_text_key TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE (source_object_key, source_etag)
);

CREATE INDEX transcription_jobs_session_created_idx
  ON transcription_jobs(examination_session_id, created_at DESC);

CREATE INDEX transcription_jobs_status_created_idx
  ON transcription_jobs(status, created_at);
