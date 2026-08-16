ALTER TABLE transcription_jobs ADD COLUMN enqueue_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transcription_jobs ADD COLUMN last_enqueue_attempt_at INTEGER;

UPDATE transcription_jobs
SET status = 'queued', completed_at = NULL
WHERE status = 'failed' AND error_code = 'workflow_enqueue_failed';

CREATE INDEX transcription_jobs_dispatch_idx
  ON transcription_jobs(status, last_enqueue_attempt_at);
