import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { Result } from "better-result";
import type {
  CurrentExaminationQuestion,
  Examination,
  ExaminationList,
  ExaminationSession,
  ExaminationSessionList,
} from "@ai-oral-exam/conversation-contract";
import {
  ArtifactStatus,
  ConversationStateTag,
  StopReason,
  TransportStatus,
  value,
  type ConversationState,
} from "../src/domain/conversation-state-machine";
import type { ConversationSession } from "../src/durable-object/conversation-session";
import { foundationDependencies } from "../src/worker/foundation-dependencies";
import { handleConversationRequest } from "../src/worker/http/conversation-api";
import type { ConversationSessions } from "../src/worker/ports/foundation";
import { authenticatedHeaders } from "./auth-helpers";

const API_ORIGIN = "https://api.example.test";
const BROWSER_ORIGIN = "http://localhost:5173";

async function browserApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = await authenticatedHeaders(init.headers);
  if (!headers.has("Origin")) headers.set("Origin", BROWSER_ORIGIN);
  return exports.default.fetch(new Request(`${API_ORIGIN}${path}`, { ...init, headers }));
}

async function agentApi(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(
    new Request(`${API_ORIGIN}${path}`, {
      ...init,
      headers: {
        Authorization: "Bearer test-agent-callback-token",
        ...Object.fromEntries(new Headers(init.headers)),
      },
    }),
  );
}

async function createExamination(questions = ["First question?", "Second question?"]) {
  const response = await browserApi("/v1/examinations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Systems exam ${crypto.randomUUID()}`,
      subject: "Distributed systems",
      questions,
    }),
  });
  return { response, examination: await response.json<Examination>() };
}

describe("examination HTTP API", () => {
  it("creates an immutable examination and returns its ordered questions", async () => {
    const created = await createExamination(["Explain consensus.", "Describe leader election."]);
    expect(created.response.status).toBe(201);
    expect(created.examination).toMatchObject({
      subject: "Distributed systems",
      questionCount: 2,
      questions: [
        { ordinal: 1, text: "Explain consensus." },
        { ordinal: 2, text: "Describe leader election." },
      ],
    });

    const detail = await browserApi(`/v1/examinations/${created.examination.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(created.examination);

    const listed = await browserApi("/v1/examinations");
    expect(listed.status).toBe(200);
    const body = await listed.json<ExaminationList>();
    expect(body.examinations).toContainEqual({
      id: created.examination.id,
      name: created.examination.name,
      subject: created.examination.subject,
      questionCount: 2,
      createdAt: created.examination.createdAt,
    });
  });

  it("rejects an examination without a valid question", async () => {
    const response = await browserApi("/v1/examinations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Empty exam", subject: "Nothing", questions: ["  "] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_examination_request" });
  });

  it("creates examination sessions idempotently and lists only the signed-in user's history", async () => {
    const { examination } = await createExamination();
    const idempotencyKey = `session-${crypto.randomUUID()}`;
    const first = await browserApi(`/v1/examinations/${examination.id}/sessions`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    });
    const created = await first.json<ExaminationSession>();
    const repeated = await browserApi(`/v1/examinations/${examination.id}/sessions`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    });
    const existing = await repeated.json<ExaminationSession>();

    expect(first.status).toBe(201);
    expect(repeated.status).toBe(200);
    expect(existing).toEqual(created);
    expect(created).toMatchObject({
      id: created.conversationId,
      examinationId: examination.id,
      examinationName: examination.name,
      questionState: "in_progress",
      currentQuestionOrdinal: 1,
      questionCount: 2,
      conversationState: "created",
      recordingAvailable: false,
    });

    const history = await browserApi("/v1/examination-sessions");
    const body = await history.json<ExaminationSessionList>();
    expect(body.sessions).toContainEqual(created);
  });

  it("serves and advances questions through authenticated, idempotent agent endpoints", async () => {
    const { examination } = await createExamination(["Question one?", "Question two?"]);
    const started = await browserApi(`/v1/examinations/${examination.id}/sessions`, {
      method: "POST",
      headers: { "Idempotency-Key": `question-flow-${crypto.randomUUID()}` },
    });
    const session = await started.json<ExaminationSession>();
    const path = `/v1/integrations/examinations/conversations/${session.conversationId}`;

    const denied = await exports.default.fetch(
      new Request(`${API_ORIGIN}${path}/current-question`),
    );
    expect(denied.status).toBe(401);

    const currentResponse = await agentApi(`${path}/current-question`);
    const current = await currentResponse.json<CurrentExaminationQuestion>();
    expect(current).toMatchObject({
      status: "question",
      question: { ordinal: 1, text: "Question one?" },
      revision: 0,
    });
    if (current.status !== "question") throw new Error("Expected the first question.");

    const completionBody = {
      questionId: current.question.id,
      expectedRevision: current.revision,
      disposition: "answered_after_follow_up",
    };
    const completed = await agentApi(`${path}/complete-question`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(completionBody),
    });
    const second = await completed.json<CurrentExaminationQuestion>();
    expect(second).toMatchObject({
      status: "question",
      question: { ordinal: 2, text: "Question two?" },
      revision: 1,
    });

    const duplicate = await agentApi(`${path}/complete-question`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(completionBody),
    });
    expect(await duplicate.json()).toEqual(second);

    if (second.status !== "question") throw new Error("Expected the second question.");
    const finished = await agentApi(`${path}/complete-question`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questionId: second.question.id,
        expectedRevision: second.revision,
        disposition: "answered",
      }),
    });
    expect(await finished.json()).toMatchObject({ status: "complete", revision: 2 });

    const detail = await browserApi(`/v1/examination-sessions/${session.id}`);
    expect(await detail.json()).toMatchObject({
      questionState: "complete",
      currentQuestionOrdinal: 2,
    });
  });

  it("streams only an owned, verified recording and supports HTTP byte ranges", async () => {
    const { examination } = await createExamination(["Recorded question?"]);
    const started = await browserApi(`/v1/examinations/${examination.id}/sessions`, {
      method: "POST",
      headers: { "Idempotency-Key": `recording-${crypto.randomUUID()}` },
    });
    const session = await started.json<ExaminationSession>();
    const objectKey = `conversations/${session.conversationId}/recording.ogg`;
    await env.RECORDINGS.put(objectKey, new Uint8Array([10, 20, 30, 40]), {
      httpMetadata: { contentType: "audio/ogg" },
    });
    const at = value.unixMillis(Date.now());
    const state: ConversationState = {
      tag: ConversationStateTag.Completed,
      revision: 10,
      enteredAt: at,
      updatedAt: at,
      data: {
        sessionId: value.conversationSessionId(session.conversationId),
        transport: { status: TransportStatus.Closed, epoch: 1, closedAt: at },
        artifact: {
          status: ArtifactStatus.Ready,
          recordingId: value.recordingId("recording-1"),
          r2Key: value.r2ObjectKey(objectKey),
          r2Etag: value.r2Etag("etag-1"),
          readyAt: at,
        },
        completedAt: at,
        terminationReason: StopReason.UserRequested,
      },
    };
    const conversations: ConversationSessions = {
      get: () =>
        ({
          getState: async () => Result.ok(state),
        }) as unknown as DurableObjectStub<ConversationSession>,
    };
    const response = await handleConversationRequest(
      new Request(`${API_ORIGIN}/v1/examination-sessions/${session.id}/recording`, {
        headers: await authenticatedHeaders({
          Origin: BROWSER_ORIGIN,
          Range: "bytes=1-2",
        }),
      }),
      env,
      { ...foundationDependencies(env), conversations },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("audio/ogg");
    expect(response.headers.get("Content-Range")).toBe("bytes 1-2/4");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([20, 30]);
  });
});
