import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationEventType,
  createConversation,
  value,
  type ConversationState,
} from "../src/domain/conversation-state-machine";
import { completeRecordingUpload } from "../src/worker/recordings/multipart-recording";
import type { FoundationDependencies } from "../src/worker/ports/foundation";
import { transition, transitionRuntime } from "./transition-test-utils";

describe("recording completion", () => {
  it("retries transcription persistence without completing the R2 upload twice", async () => {
    const conversationId = crypto.randomUUID();
    const uploadId = `upload-${crypto.randomUUID()}`;
    const objectKey = `conversations/${conversationId}/recording.webm`;
    const etag = "recording-etag";
    await insertCompletedExaminationSession(conversationId);

    let state: ConversationState = uploadingState(conversationId, uploadId, objectKey);
    const getState = vi.fn(() => ({ status: "ok" as const, value: state }));
    const applyIntegrationEvent = vi.fn(
      (command: { readonly event: Parameters<typeof transitionRuntime>[1] }) => {
        state = transitionRuntime(state, command.event);
        return {
          status: "ok" as const,
          value: { outcome: "applied" as const, state, receipt: {} },
        };
      },
    );
    const complete = vi.fn(async () => ({ etag }));
    const createBatch = vi.fn(async () => []);
    let databaseAvailable = false;
    // SAFETY: the mock delegates every exercised D1 operation to the real test binding.
    const database = {
      prepare: (query: string) => {
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- simulates a binding outage.
        if (!databaseAvailable) throw new Error("D1 unavailable");
        return env.EXAM_DB.prepare(query);
      },
      batch: (statements: D1PreparedStatement[]) => env.EXAM_DB.batch(statements),
    } as D1Database;
    // SAFETY: completion exercises only multipart-upload resumption on this R2 mock.
    const recordingBucket = Object.assign(Object.create(null), {
      resumeMultipartUpload: vi.fn(() => ({ complete })),
    }) as R2Bucket;
    // SAFETY: completion exercises only batch creation on this workflow binding.
    const workflow = Object.assign(Object.create(null), {
      createBatch,
    }) as Env["TRANSCRIPTION_WORKFLOW"];
    // SAFETY: this focused environment supplies every binding used by completion.
    const completionEnv = {
      EXAM_DB: database,
      RECORDINGS: recordingBucket,
      TRANSCRIPTION_WORKFLOW: workflow,
    } as Env;
    // SAFETY: this focused dependency set supplies every port used by completion.
    const dependencies = Object.assign(Object.create(null), {
      clock: { now: () => 100 },
      ids: { randomUuid: () => crypto.randomUUID() },
      conversations: {
        get: () => ({ getState, applyIntegrationEvent }),
      },
      recordings: { head: async () => null },
    }) as FoundationDependencies;
    const request = () => completionRequest(conversationId, uploadId, objectKey);

    const first = await completeRecordingUpload(
      request(),
      conversationId,
      completionEnv,
      dependencies,
    );
    expect(first).toMatchObject({
      status: "error",
      error: { telemetry: { operation: "persist_transcription_job" } },
    });

    databaseAvailable = true;
    const replay = await completeRecordingUpload(
      request(),
      conversationId,
      completionEnv,
      dependencies,
    );

    expect(replay).toMatchObject({
      status: "ok",
      value: { outcome: "recording_upload_completion_replayed" },
    });
    expect(recordingBucket.resumeMultipartUpload).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(applyIntegrationEvent).toHaveBeenCalledOnce();
    expect(createBatch).toHaveBeenCalledOnce();
    expect(
      await env.EXAM_DB.prepare(
        `SELECT status, source_object_key, source_etag FROM transcription_jobs
         WHERE examination_session_id = ?`,
      )
        .bind(`session-${conversationId}`)
        .first(),
    ).toMatchObject({ status: "queued", source_object_key: objectKey, source_etag: etag });
  });
});

function uploadingState(conversationId: string, uploadId: string, objectKey: string) {
  const at = value.unixMillis;
  const starting = transition(
    createConversation(value.conversationSessionId(conversationId), at(1)),
    {
      type: ConversationEventType.StartRequested,
      eventId: "start",
      at: at(2),
      startDeadlineAt: at(1_000),
    },
  );
  const connected = transition(starting, {
    type: ConversationEventType.TransportConnected,
    eventId: "connected",
    at: at(3),
    epoch: 1,
  });
  const recording = transition(connected, {
    type: ConversationEventType.RecordingStarted,
    eventId: "recording",
    at: at(4),
    recordingId: value.recordingId(uploadId),
  });
  const live = transition(recording, {
    type: ConversationEventType.SessionStarted,
    eventId: "session",
    at: at(5),
    epoch: 1,
    maximumEndAt: at(10_000),
  });
  const ending = transition(live, {
    type: ConversationEventType.EndRequested,
    eventId: "end",
    at: at(6),
    reason: "done",
    endingDeadlineAt: at(2_000),
  });
  const closed = transition(ending, {
    type: ConversationEventType.SessionClosed,
    eventId: "closed",
    at: at(7),
    epoch: 1,
  });
  return transitionRuntime(closed, {
    type: ConversationEventType.RecordingUploadStarted,
    eventId: "upload",
    at: at(8),
    recordingId: value.recordingId(uploadId),
    expectedR2Key: value.r2ObjectKey(objectKey),
    artifactDeadlineAt: at(2_000),
  });
}

function completionRequest(conversationId: string, uploadId: string, objectKey: string): Request {
  return new Request(`https://example.test/v1/conversations/${conversationId}/recording/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      uploadId,
      objectKey,
      parts: [{ partNumber: 1, etag: "part-etag" }],
    }),
  });
}

async function insertCompletedExaminationSession(conversationId: string): Promise<void> {
  const user = await env.EXAM_DB.prepare(`SELECT id FROM users WHERE username = 'examiner'`).first<{
    id: number;
  }>();
  expect(user).not.toBeNull();
  if (user === null) return;
  await env.EXAM_DB.batch([
    env.EXAM_DB.prepare(
      `INSERT INTO examinations (id, created_by_user_id, name, subject, created_at)
       VALUES (?, ?, 'Recording completion', 'Distributed systems', ?)`,
    ).bind(`exam-${conversationId}`, user.id, Date.now()),
    env.EXAM_DB.prepare(
      `INSERT INTO examination_sessions (
         id, examination_id, user_id, conversation_id, question_state, created_at
       ) VALUES (?, ?, ?, ?, 'complete', ?)`,
    ).bind(
      `session-${conversationId}`,
      `exam-${conversationId}`,
      user.id,
      conversationId,
      Date.now(),
    ),
  ]);
}
