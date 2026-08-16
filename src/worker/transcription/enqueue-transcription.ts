/** Creates one idempotent transcription job for a completed examination recording. */
import { TRANSCRIPTION_MODEL } from "./transcript-artifacts";
import type { TranscriptionWorkflowParams } from "./transcription-workflow";

interface CompletedSessionRow {
  readonly id: string;
}

export type EnqueueTranscriptionOutcome = "enqueued" | "already_exists" | "exam_incomplete";

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
  if (inserted.meta.changes === 0) return "already_exists";

  const params: TranscriptionWorkflowParams = {
    jobId,
    conversationId: input.conversationId,
    objectKey: input.objectKey,
    etag: input.etag,
  };
  try {
    await env.TRANSCRIPTION_WORKFLOW.create({
      id: jobId,
      params,
      retention: { successRetention: "30 days", errorRetention: "30 days" },
    });
  } catch {
    await env.EXAM_DB.prepare(
      `UPDATE transcription_jobs
       SET status = 'failed', error_code = 'workflow_enqueue_failed', completed_at = ?
       WHERE id = ?`,
    )
      .bind(Date.now(), jobId)
      .run();
    throw new Error("The transcription Workflow could not be enqueued.");
  }
  return "enqueued";
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
