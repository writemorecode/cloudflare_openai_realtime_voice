import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { reconcileQueuedTranscriptionJobs } from "../src/worker/transcription/enqueue-transcription";

async function insertQueuedJob(id: string): Promise<void> {
  const user = await env.EXAM_DB.prepare(`SELECT id FROM users WHERE username = 'examiner'`).first<{
    id: number;
  }>();
  if (user === null) throw new Error("The test examiner is missing.");
  const examinationId = `examination-${id}`;
  const sessionId = `session-${id}`;
  const conversationId = crypto.randomUUID();
  await env.EXAM_DB.batch([
    env.EXAM_DB.prepare(
      `INSERT INTO examinations (id, created_by_user_id, name, subject, created_at)
       VALUES (?, ?, 'Dispatch test', 'Distributed systems', ?)`,
    ).bind(examinationId, user.id, Date.now()),
    env.EXAM_DB.prepare(
      `INSERT INTO examination_sessions (
         id, examination_id, user_id, conversation_id, question_state, created_at
       ) VALUES (?, ?, ?, ?, 'complete', ?)`,
    ).bind(sessionId, examinationId, user.id, conversationId, Date.now()),
    env.EXAM_DB.prepare(
      `INSERT INTO transcription_jobs (
         id, examination_session_id, source_object_key, source_etag, model, status, created_at
       ) VALUES (?, ?, ?, ?, 'assemblyai/universal-3-pro', 'queued', ?)`,
    ).bind(
      id,
      sessionId,
      `conversations/${conversationId}/recording.webm`,
      `etag-${id}`,
      Date.now(),
    ),
  ]);
}

function dispatchEnv(createBatch: ReturnType<typeof vi.fn>): Env {
  return {
    EXAM_DB: env.EXAM_DB,
    TRANSCRIPTION_WORKFLOW: { createBatch },
  } as unknown as Env;
}

describe("transcription Workflow dispatch", () => {
  it("dispatches queued jobs idempotently and records the attempt", async () => {
    const id = `dispatch-success-${crypto.randomUUID()}`;
    await insertQueuedJob(id);
    const createBatch = vi.fn(async () => []);

    expect(await reconcileQueuedTranscriptionJobs(dispatchEnv(createBatch), 10_000_000)).toBe(1);
    expect(createBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        id,
        params: expect.objectContaining({ jobId: id }),
        retention: { successRetention: "30 days", errorRetention: "30 days" },
      }),
    ]);
    expect(
      await env.EXAM_DB.prepare(
        `SELECT status, enqueue_attempts, last_enqueue_attempt_at, error_code
         FROM transcription_jobs WHERE id = ?`,
      )
        .bind(id)
        .first(),
    ).toMatchObject({
      status: "queued",
      enqueue_attempts: 1,
      last_enqueue_attempt_at: 10_000_000,
      error_code: null,
    });
  });

  it("retains failed dispatches for a later reconciliation attempt", async () => {
    const id = `dispatch-failure-${crypto.randomUUID()}`;
    await insertQueuedJob(id);
    const createBatch = vi.fn(async () => {
      throw new Error("temporary Workflows failure");
    });

    await expect(
      reconcileQueuedTranscriptionJobs(dispatchEnv(createBatch), 20_000_000),
    ).rejects.toThrow("could not be enqueued");
    expect(
      await env.EXAM_DB.prepare(
        `SELECT status, enqueue_attempts, last_enqueue_attempt_at, error_code, completed_at
         FROM transcription_jobs WHERE id = ?`,
      )
        .bind(id)
        .first(),
    ).toMatchObject({
      status: "queued",
      enqueue_attempts: 1,
      last_enqueue_attempt_at: 20_000_000,
      error_code: "workflow_enqueue_failed",
      completed_at: null,
    });
  });
});
