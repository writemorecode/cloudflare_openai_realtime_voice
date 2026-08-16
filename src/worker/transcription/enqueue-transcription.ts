/** Creates one idempotent transcription job for a completed examination recording. */
import { Result } from "better-result";

import { TRANSCRIPTION_MODEL } from "./transcript-artifacts";
import type { TranscriptionWorkflowParams } from "./transcription-workflow";

interface CompletedSessionRow {
  readonly id: string;
}

interface QueuedTranscriptionJobRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly source_object_key: string;
  readonly source_etag: string;
}

interface TranscriptionJobStatusRow {
  readonly status: "queued" | "running" | "complete" | "failed";
}

const DISPATCH_RETRY_AFTER_MS = 5 * 60 * 1000;
const DISPATCH_BATCH_SIZE = 100;
const WORKFLOW_RETENTION = {
  successRetention: "30 days",
  errorRetention: "30 days",
} as const;

export type EnqueueTranscriptionOutcome =
  | "enqueued"
  | "already_exists"
  | "exam_incomplete"
  | "dispatch_pending";

export async function enqueueCompletedRecordingTranscription(
  env: Env,
  input: {
    readonly conversationId: string;
    readonly objectKey: string;
    readonly etag: string;
    readonly createdAt: number;
  },
): Promise<EnqueueTranscriptionOutcome> {
  const session = await env.EXAM_DB.prepare(
    `SELECT id
     FROM examination_sessions
     WHERE conversation_id = ? AND question_state = 'complete'`,
  )
    .bind(input.conversationId)
    .first<CompletedSessionRow>();
  if (session === null) return "exam_incomplete";

  const jobId = await transcriptionJobId(input.conversationId, input.objectKey, input.etag);
  const inserted = await env.EXAM_DB.prepare(
    `INSERT OR IGNORE INTO transcription_jobs (
       id, examination_session_id, source_object_key, source_etag, model, status, created_at
     ) VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
  )
    .bind(jobId, session.id, input.objectKey, input.etag, TRANSCRIPTION_MODEL, input.createdAt)
    .run();
  const outcome = inserted.meta.changes === 0 ? "already_exists" : "enqueued";
  if (inserted.meta.changes === 0) {
    const existing = await env.EXAM_DB.prepare(`SELECT status FROM transcription_jobs WHERE id = ?`)
      .bind(jobId)
      .first<TranscriptionJobStatusRow>();
    if (existing?.status !== "queued") return outcome;
  }

  const params: TranscriptionWorkflowParams = {
    jobId,
    conversationId: input.conversationId,
    objectKey: input.objectKey,
    etag: input.etag,
  };
  const dispatched = await Result.tryPromise({
    try: () => dispatchTranscriptionJobs(env, [{ id: jobId, params }], Date.now()),
    catch: (cause) => cause,
  });
  return dispatched.isOk() ? outcome : "dispatch_pending";
}

export async function reconcileQueuedTranscriptionJobs(
  env: Env,
  now = Date.now(),
): Promise<number> {
  const retryBefore = now - DISPATCH_RETRY_AFTER_MS;
  const rows = await env.EXAM_DB.prepare(
    `SELECT jobs.id, sessions.conversation_id, jobs.source_object_key, jobs.source_etag
     FROM transcription_jobs AS jobs
     JOIN examination_sessions AS sessions ON sessions.id = jobs.examination_session_id
     WHERE jobs.status = 'queued'
       AND (jobs.last_enqueue_attempt_at IS NULL OR jobs.last_enqueue_attempt_at <= ?)
     ORDER BY jobs.created_at
     LIMIT ?`,
  )
    .bind(retryBefore, DISPATCH_BATCH_SIZE)
    .all<QueuedTranscriptionJobRow>();
  const jobs = rows.results.map((row) => ({
    id: row.id,
    params: {
      jobId: row.id,
      conversationId: row.conversation_id,
      objectKey: row.source_object_key,
      etag: row.source_etag,
    },
  }));
  await dispatchTranscriptionJobs(env, jobs, now);
  return jobs.length;
}

async function dispatchTranscriptionJobs(
  env: Env,
  jobs: readonly { readonly id: string; readonly params: TranscriptionWorkflowParams }[],
  attemptedAt: number,
): Promise<void> {
  if (jobs.length === 0) return;
  await env.EXAM_DB.batch(
    jobs.map((job) =>
      env.EXAM_DB.prepare(
        `UPDATE transcription_jobs
         SET enqueue_attempts = enqueue_attempts + 1, last_enqueue_attempt_at = ?
         WHERE id = ? AND status = 'queued'`,
      ).bind(attemptedAt, job.id),
    ),
  );
  try {
    await env.TRANSCRIPTION_WORKFLOW.createBatch(
      jobs.map((job) => ({ id: job.id, params: job.params, retention: WORKFLOW_RETENTION })),
    );
    await setDispatchError(env.EXAM_DB, jobs, null);
  } catch (cause) {
    await setDispatchError(env.EXAM_DB, jobs, "workflow_enqueue_failed");
    throw new Error("The transcription Workflow could not be enqueued.", { cause });
  }
}

async function setDispatchError(
  database: D1Database,
  jobs: readonly { readonly id: string }[],
  errorCode: string | null,
): Promise<void> {
  await database.batch(
    jobs.map((job) =>
      database
        .prepare(`UPDATE transcription_jobs SET error_code = ? WHERE id = ? AND status = 'queued'`)
        .bind(errorCode, job.id),
    ),
  );
}

async function transcriptionJobId(
  conversationId: string,
  objectKey: string,
  etag: string,
): Promise<string> {
  const input = new TextEncoder().encode(`${objectKey}\n${etag}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `transcription-${conversationId}-${hash.slice(0, 24)}`;
}
