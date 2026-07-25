/** Application services for authenticated examination HTTP endpoints and agent question tools. */
import {
  ArtifactStatus,
  ConversationStateTag,
  completeExaminationQuestionRequestSchema,
  createExaminationRequestSchema,
  type CurrentExaminationQuestion,
  type ExaminationSession,
} from "@ai-oral-exam/conversation-contract";
import { err, ok, tryCatch, type Result } from "@ai-oral-exam/result";

import { value, type ConversationState } from "../../domain/conversation-state-machine";
import type { AggregateStoreResult } from "../../durable-object/conversation-aggregate-store";
import type { InitializeResult } from "../../durable-object/conversation-session";
import { ApiError } from "../http/api-errors";
import { deriveConversationId, validateIdempotencyKey } from "../http/api-security";
import type { AuthenticatedUser } from "../http/browser-auth";
import type { FoundationDependencies } from "../ports/foundation";
import {
  completeExaminationQuestion,
  findExamination,
  findExaminationSessionById,
  getCurrentExaminationQuestion,
  insertExamination,
  insertExaminationSession,
  listExaminations,
  listExaminationSessions,
  publicExaminationSession,
  type StoredExaminationSession,
} from "./examination-repository";

const MAX_EXAMINATION_BODY_BYTES = 512 * 1024;
const SESSION_IDEMPOTENCY_PREFIX = "examination-session:v1:";

export interface ExaminationApiResult {
  readonly response: Response;
  readonly conversationId: string | null;
  readonly outcome: string;
}

type ApiResult<T> = Result<T, ApiError>;

export async function createExamination(
  request: Request,
  user: AuthenticatedUser,
  env: Env,
  dependencies: Pick<FoundationDependencies, "clock" | "ids">,
): Promise<ApiResult<ExaminationApiResult>> {
  const parsed = await readJson(request, createExaminationRequestSchema);
  if (!parsed.ok) return parsed;
  const examinationId = dependencies.ids.randomUuid();
  const questionIds = parsed.value.questions.map(() => dependencies.ids.randomUuid());
  const inserted = await tryCatch(
    () =>
      insertExamination(env.EXAM_DB, {
        id: examinationId,
        userId: user.id,
        request: parsed.value,
        questionIds,
        createdAt: dependencies.clock.now(),
      }),
    examinationOperationFailed,
  );
  if (!inserted.ok) return inserted;
  return ok({
    response: Response.json(inserted.value, { status: 201 }),
    conversationId: null,
    outcome: "examination_created",
  });
}

export async function getExaminations(env: Env): Promise<ApiResult<ExaminationApiResult>> {
  const examinations = await tryCatch(
    () => listExaminations(env.EXAM_DB),
    examinationOperationFailed,
  );
  if (!examinations.ok) return examinations;
  return ok({
    response: Response.json({ examinations: examinations.value }),
    conversationId: null,
    outcome: "examinations_returned",
  });
}

export async function getExamination(
  examinationId: string,
  env: Env,
): Promise<ApiResult<ExaminationApiResult>> {
  const examination = await tryCatch(
    () => findExamination(env.EXAM_DB, examinationId),
    examinationOperationFailed,
  );
  if (!examination.ok) return examination;
  if (examination.value === null) {
    return err(new ApiError(404, "examination_not_found", "Examination not found."));
  }
  return ok({
    response: Response.json(examination.value),
    conversationId: null,
    outcome: "examination_returned",
  });
}

export async function createExaminationSession(
  request: Request,
  examinationId: string,
  user: AuthenticatedUser,
  env: Env,
  dependencies: Pick<FoundationDependencies, "clock" | "conversations">,
): Promise<ApiResult<ExaminationApiResult>> {
  const examination = await tryCatch(
    () => findExamination(env.EXAM_DB, examinationId),
    examinationOperationFailed,
  );
  if (!examination.ok) return examination;
  if (examination.value === null) {
    return err(new ApiError(404, "examination_not_found", "Examination not found."));
  }

  const idempotencyKey = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotencyKey.ok) return idempotencyKey;
  const derived = await deriveConversationId(
    env.CONVERSATION_ID_SECRET,
    `${SESSION_IDEMPOTENCY_PREFIX}${examinationId}:${idempotencyKey.value}`,
  );
  if (!derived.ok) return derived;
  const conversationId = derived.value;

  const initialized = await initializeConversation(conversationId, dependencies);
  if (!initialized.ok) return initialized;

  const session = await tryCatch(
    () =>
      insertExaminationSession(env.EXAM_DB, {
        id: conversationId,
        examinationId,
        userId: user.id,
        conversationId,
        createdAt: dependencies.clock.now(),
      }),
    examinationOperationFailed,
  );
  if (!session.ok) return session;
  if (session.value === null) {
    return err(
      new ApiError(500, "examination_session_missing", "The examination session is missing."),
    );
  }
  if (session.value.examinationId !== examinationId || session.value.userId !== user.id) {
    return err(
      new ApiError(
        409,
        "examination_session_identity_conflict",
        "Examination session identity conflict.",
      ),
    );
  }

  const publicSession = publicExaminationSession(
    session.value,
    initialized.value.state.tag,
    isRecordingAvailable(initialized.value.state),
  );
  return ok({
    response: Response.json(publicSession, {
      status: initialized.value.status === "initialized" ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    }),
    conversationId,
    outcome:
      initialized.value.status === "initialized"
        ? "examination_session_created"
        : "examination_session_returned",
  });
}

export async function getExaminationSessions(
  user: AuthenticatedUser,
  env: Env,
  dependencies: Pick<FoundationDependencies, "conversations">,
): Promise<ApiResult<ExaminationApiResult>> {
  const stored = await tryCatch(
    () => listExaminationSessions(env.EXAM_DB, user.id),
    examinationOperationFailed,
  );
  if (!stored.ok) return stored;
  const hydrated = await Promise.all(
    stored.value.map((session) => hydrateSession(session, dependencies)),
  );
  for (const result of hydrated) {
    if (!result.ok) return result;
  }
  return ok({
    response: Response.json({
      sessions: hydrated.map((result) => {
        if (!result.ok) throw result.error;
        return result.value;
      }),
    }),
    conversationId: null,
    outcome: "examination_sessions_returned",
  });
}

export async function getExaminationSession(
  examinationSessionId: string,
  user: AuthenticatedUser,
  env: Env,
  dependencies: Pick<FoundationDependencies, "conversations">,
): Promise<ApiResult<ExaminationApiResult>> {
  const stored = await ownedSession(examinationSessionId, user, env);
  if (!stored.ok) return stored;
  const hydrated = await hydrateSession(stored.value, dependencies);
  if (!hydrated.ok) return hydrated;
  return ok({
    response: Response.json(hydrated.value, { headers: { "Cache-Control": "no-store" } }),
    conversationId: hydrated.value.conversationId,
    outcome: "examination_session_returned",
  });
}

export async function getExaminationSessionRecording(
  request: Request,
  examinationSessionId: string,
  user: AuthenticatedUser,
  env: Env,
  dependencies: Pick<FoundationDependencies, "conversations">,
): Promise<ApiResult<ExaminationApiResult>> {
  const stored = await ownedSession(examinationSessionId, user, env);
  if (!stored.ok) return stored;
  const state = await readConversationState(stored.value.conversationId, dependencies);
  if (!state.ok) return state;
  if (
    state.value?.tag !== ConversationStateTag.Completed ||
    state.value.data.artifact.status !== ArtifactStatus.Ready
  ) {
    return err(new ApiError(409, "recording_not_ready", "The examination recording is not ready."));
  }

  const objectKey = state.value.data.artifact.r2Key;
  const head = await tryCatch(() => env.RECORDINGS.head(objectKey), examinationOperationFailed);
  if (!head.ok) return head;
  if (head.value === null) {
    return err(new ApiError(409, "recording_not_ready", "The examination recording is not ready."));
  }
  const range = parseRange(request.headers.get("Range"), head.value.size);
  if (!range.ok) return range;
  const object = await tryCatch(
    () => env.RECORDINGS.get(objectKey, range.value === null ? undefined : { range: range.value }),
    examinationOperationFailed,
  );
  if (!object.ok) return object;
  if (object.value === null) {
    return err(new ApiError(409, "recording_not_ready", "The examination recording is not ready."));
  }

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    ETag: object.value.httpEtag,
  });
  object.value.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "audio/ogg");
  if (range.value === null) {
    headers.set("Content-Length", String(object.value.size));
  } else {
    headers.set("Content-Length", String(range.value.length));
    headers.set(
      "Content-Range",
      `bytes ${range.value.offset}-${range.value.offset + range.value.length - 1}/${head.value.size}`,
    );
  }
  return ok({
    response: new Response(object.value.body, {
      status: range.value === null ? 200 : 206,
      headers,
    }),
    conversationId: stored.value.conversationId,
    outcome: range.value === null ? "recording_streamed" : "recording_range_streamed",
  });
}

export async function getAgentCurrentQuestion(
  conversationId: string,
  env: Env,
): Promise<ApiResult<ExaminationApiResult>> {
  const current = await tryCatch(
    () => getCurrentExaminationQuestion(env.EXAM_DB, conversationId),
    examinationOperationFailed,
  );
  if (!current.ok) return current;
  if (current.value === null) {
    return err(
      new ApiError(404, "examination_session_not_found", "Examination session not found."),
    );
  }
  return ok(questionResult(current.value, conversationId, "current_question_returned"));
}

export async function completeAgentCurrentQuestion(
  request: Request,
  conversationId: string,
  env: Env,
  dependencies: Pick<FoundationDependencies, "clock">,
): Promise<ApiResult<ExaminationApiResult>> {
  const parsed = await readJson(request, completeExaminationQuestionRequestSchema);
  if (!parsed.ok) return parsed;
  const completed = await tryCatch(
    () =>
      completeExaminationQuestion(env.EXAM_DB, {
        conversationId,
        ...parsed.value,
        completedAt: dependencies.clock.now(),
      }),
    examinationOperationFailed,
  );
  if (!completed.ok) return completed;
  if (completed.value.status === "not_found") {
    return err(
      new ApiError(404, "examination_session_not_found", "Examination session not found."),
    );
  }
  if (completed.value.status === "conflict") {
    return err(
      new ApiError(
        409,
        "examination_question_conflict",
        "The current examination question changed.",
      ),
    );
  }
  return ok(
    questionResult(
      completed.value.current,
      conversationId,
      completed.value.status === "advanced"
        ? "examination_question_completed"
        : "examination_question_already_completed",
    ),
  );
}

async function ownedSession(
  examinationSessionId: string,
  user: AuthenticatedUser,
  env: Env,
): Promise<ApiResult<StoredExaminationSession>> {
  const stored = await tryCatch(
    () => findExaminationSessionById(env.EXAM_DB, examinationSessionId),
    examinationOperationFailed,
  );
  if (!stored.ok) return stored;
  if (stored.value === null || stored.value.userId !== user.id) {
    return err(
      new ApiError(404, "examination_session_not_found", "Examination session not found."),
    );
  }
  return ok(stored.value);
}

async function initializeConversation(
  conversationId: string,
  dependencies: Pick<FoundationDependencies, "clock" | "conversations">,
): Promise<
  ApiResult<{
    readonly status: "initialized" | "existing";
    readonly state: ConversationState;
  }>
> {
  const initialized = await tryCatch(
    async (): Promise<AggregateStoreResult<InitializeResult>> =>
      await dependencies.conversations
        .get(conversationId)
        .initialize(
          value.conversationSessionId(conversationId),
          value.unixMillis(dependencies.clock.now()),
        ),
    examinationOperationFailed,
  );
  if (!initialized.ok) return initialized;
  if (!initialized.value.ok) return err(examinationOperationFailed(initialized.value.error));
  if (initialized.value.value.status === "rejected") {
    return err(
      new ApiError(409, "conversation_identity_conflict", "Conversation identity conflict."),
    );
  }
  return ok({
    status: initialized.value.value.status,
    state: initialized.value.value.state,
  });
}

async function hydrateSession(
  stored: StoredExaminationSession,
  dependencies: Pick<FoundationDependencies, "conversations">,
): Promise<ApiResult<ExaminationSession>> {
  const state = await readConversationState(stored.conversationId, dependencies);
  if (!state.ok) return state;
  return ok(
    publicExaminationSession(
      stored,
      state.value?.tag ?? null,
      state.value === null ? false : isRecordingAvailable(state.value),
    ),
  );
}

async function readConversationState(
  conversationId: string,
  dependencies: Pick<FoundationDependencies, "conversations">,
): Promise<ApiResult<ConversationState | null>> {
  const stored = await tryCatch(
    async (): Promise<AggregateStoreResult<ConversationState | null>> =>
      await dependencies.conversations.get(conversationId).getState(),
    examinationOperationFailed,
  );
  if (!stored.ok) return stored;
  return stored.value.ok
    ? ok(stored.value.value)
    : err(examinationOperationFailed(stored.value.error));
}

function isRecordingAvailable(state: ConversationState): boolean {
  return (
    state.tag === ConversationStateTag.Completed &&
    state.data.artifact.status === ArtifactStatus.Ready
  );
}

function questionResult(
  current: CurrentExaminationQuestion,
  conversationId: string,
  outcome: string,
): ExaminationApiResult {
  return {
    response: Response.json(current, { headers: { "Cache-Control": "no-store" } }),
    conversationId,
    outcome,
  };
}

async function readJson<T>(
  request: Request,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
): Promise<ApiResult<T>> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return err(
      new ApiError(415, "unsupported_media_type", "Content-Type must be application/json."),
    );
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_EXAMINATION_BODY_BYTES) {
    return err(
      new ApiError(413, "examination_request_too_large", "The request body is too large."),
    );
  }
  const body = await tryCatch(() => request.arrayBuffer(), examinationOperationFailed);
  if (!body.ok) return body;
  if (body.value.byteLength > MAX_EXAMINATION_BODY_BYTES) {
    return err(
      new ApiError(413, "examination_request_too_large", "The request body is too large."),
    );
  }
  const decoded = await tryCatch(
    () => JSON.parse(new TextDecoder().decode(body.value)) as unknown,
    () => new ApiError(400, "invalid_examination_request", "The request body is invalid."),
  );
  if (!decoded.ok) return decoded;
  const parsed = schema.safeParse(decoded.value);
  return parsed.success
    ? ok(parsed.data)
    : err(new ApiError(400, "invalid_examination_request", "The request body is invalid."));
}

function examinationOperationFailed(cause: unknown): ApiError {
  return new ApiError(
    500,
    "examination_operation_failed",
    "The examination operation could not be completed.",
    {},
    cause,
  );
}

function parseRange(
  header: string | null,
  size: number,
): ApiResult<{ readonly offset: number; readonly length: number } | null> {
  if (header === null) return ok(null);
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) {
    return err(rangeNotSatisfiable(size));
  }
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "") {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || size === 0) {
      return err(rangeNotSatisfiable(size));
    }
    const length = Math.min(suffixLength, size);
    return ok({ offset: size - length, length });
  }
  const offset = Number(startText);
  const requestedEnd = endText === "" ? size - 1 : Number(endText);
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(requestedEnd) ||
    offset < 0 ||
    offset >= size ||
    requestedEnd < offset
  ) {
    return err(rangeNotSatisfiable(size));
  }
  const end = Math.min(requestedEnd, size - 1);
  return ok({ offset, length: end - offset + 1 });
}

function rangeNotSatisfiable(size: number): ApiError {
  return new ApiError(416, "recording_range_not_satisfiable", "The recording range is invalid.", {
    "Content-Range": `bytes */${size}`,
  });
}
