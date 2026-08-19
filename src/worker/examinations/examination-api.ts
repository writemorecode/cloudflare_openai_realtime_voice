/** Application services for authenticated examination HTTP endpoints and Realtime question tools. */
import {
  ArtifactStatus,
  ConversationStateTag,
  completeExaminationQuestionRequestSchema,
  createExaminationRequestSchema,
  deserializeResult,
  transcriptSchema,
  type CurrentExaminationQuestion,
  type ExaminationSession,
} from "@ai-oral-exam/conversation-contract";
import { Result } from "better-result";

import { value, type ConversationState } from "../../domain/conversation-state-machine";
import type {
  AggregateStoreError,
  AggregateStoreResult,
} from "../../durable-object/conversation-aggregate-store";
import type { InitializeResult } from "../../durable-object/conversation-session";
import { ApiError } from "../http/api-errors";
import { deriveConversationId, validateIdempotencyKey } from "../http/api-security";
import type { AuthenticatedUser } from "../http/browser-auth";
import type { FoundationDependencies } from "../ports/foundation";
import {
  completeExaminationQuestion,
  findExamination,
  findExaminationSessionById,
  findLatestTranscriptionStatus,
  getCurrentExaminationQuestion,
  insertExamination,
  insertExaminationSession,
  listExaminations,
  listExaminationSessions,
  publicExaminationSession,
  type StoredExaminationSession,
} from "./examination-repository";

const MAX_EXAMINATION_BODY_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_BODY_BYTES = 5 * 1024 * 1024;
const SESSION_IDEMPOTENCY_PREFIX = "examination-session:v1:";

export interface ExaminationApiResult {
  readonly response: Response;
  readonly conversationId: string | null;
  readonly outcome: string;
}

type ApiResult<T> = Result<T, ApiError>;

export async function authorizeExaminationConversation(
  conversationId: string,
  user: AuthenticatedUser,
  env: Env,
): Promise<ApiResult<void>> {
  const owned = await ownedSession(conversationId, user, env);
  return owned.isOk() ? Result.ok(undefined) : owned;
}

export async function createExamination(
  request: Request,
  user: AuthenticatedUser,
  env: Env,
  dependencies: Pick<FoundationDependencies, "clock" | "ids">,
): Promise<ApiResult<ExaminationApiResult>> {
  const parsed = await readJson(request, createExaminationRequestSchema);
  if (!parsed.isOk()) return parsed;
  const examinationId = dependencies.ids.randomUuid();
  const questionIds = parsed.value.questions.map(() => dependencies.ids.randomUuid());
  const inserted = await Result.tryPromise({
    try: () =>
      insertExamination(env.EXAM_DB, {
        id: examinationId,
        userId: user.id,
        request: parsed.value,
        questionIds,
        createdAt: dependencies.clock.now(),
      }),
    catch: examinationOperationFailed("insert_examination"),
  });
  if (!inserted.isOk()) return inserted;
  if (!inserted.value.isOk())
    return Result.err(examinationFailure("insert_examination", inserted.value.error));
  return Result.ok({
    response: Response.json(inserted.value.value, { status: 201 }),
    conversationId: null,
    outcome: "examination_created",
  });
}

export async function getExaminations(env: Env): Promise<ApiResult<ExaminationApiResult>> {
  const examinations = await Result.tryPromise({
    try: () => listExaminations(env.EXAM_DB),
    catch: examinationOperationFailed("list_examinations"),
  });
  if (!examinations.isOk()) return examinations;
  return Result.ok({
    response: Response.json({ examinations: examinations.value }),
    conversationId: null,
    outcome: "examinations_returned",
  });
}

export async function getExamination(
  examinationId: string,
  env: Env,
): Promise<ApiResult<ExaminationApiResult>> {
  const examination = await Result.tryPromise({
    try: () => findExamination(env.EXAM_DB, examinationId),
    catch: examinationOperationFailed("find_examination"),
  });
  if (!examination.isOk()) return examination;
  if (examination.value === null) {
    return Result.err(new ApiError(404, "examination_not_found", "Examination not found."));
  }
  return Result.ok({
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
  const examination = await Result.tryPromise({
    try: () => findExamination(env.EXAM_DB, examinationId),
    catch: examinationOperationFailed("find_examination_for_session"),
  });
  if (!examination.isOk()) return examination;
  if (examination.value === null) {
    return Result.err(new ApiError(404, "examination_not_found", "Examination not found."));
  }

  const idempotencyKey = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotencyKey.isOk()) return idempotencyKey;
  const derived = await deriveConversationId(
    env.CONVERSATION_ID_SECRET,
    `${SESSION_IDEMPOTENCY_PREFIX}${examinationId}:${idempotencyKey.value}`,
  );
  if (!derived.isOk()) return derived;
  const conversationId = derived.value;

  const initialized = await initializeConversation(conversationId, dependencies);
  if (!initialized.isOk()) return initialized;

  const session = await Result.tryPromise({
    try: () =>
      insertExaminationSession(env.EXAM_DB, {
        id: conversationId,
        examinationId,
        userId: user.id,
        conversationId,
        createdAt: dependencies.clock.now(),
      }),
    catch: examinationOperationFailed("insert_examination_session"),
  });
  if (!session.isOk()) return session;
  if (session.value === null) {
    return Result.err(
      new ApiError(500, "examination_session_missing", "The examination session is missing."),
    );
  }
  if (session.value.examinationId !== examinationId || session.value.userId !== user.id) {
    return Result.err(
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
    null,
  );
  return Result.ok({
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
  const stored = await Result.tryPromise({
    try: () => listExaminationSessions(env.EXAM_DB, user.id),
    catch: examinationOperationFailed("list_examination_sessions"),
  });
  if (!stored.isOk()) return stored;
  const hydrated = await Promise.all(
    stored.value.map((session) => hydrateSession(session, env, dependencies)),
  );
  const sessions: ExaminationSession[] = [];
  for (const result of hydrated) {
    if (!result.isOk()) return result;
    sessions.push(result.value);
  }
  return Result.ok({
    response: Response.json({
      sessions,
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
  if (!stored.isOk()) return stored;
  const hydrated = await hydrateSession(stored.value, env, dependencies);
  if (!hydrated.isOk()) return hydrated;
  return Result.ok({
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
  if (!stored.isOk()) return stored;
  const state = await readConversationState(stored.value.conversationId, dependencies);
  if (!state.isOk()) return state;
  if (
    state.value?.tag !== ConversationStateTag.Completed ||
    state.value.data.artifact.status !== ArtifactStatus.Ready
  ) {
    return Result.err(
      new ApiError(409, "recording_not_ready", "The examination recording is not ready."),
    );
  }

  const objectKey = state.value.data.artifact.r2Key;
  const head = await Result.tryPromise({
    try: () => env.RECORDINGS.head(objectKey),
    catch: examinationOperationFailed("head_examination_recording"),
  });
  if (!head.isOk()) return head;
  if (head.value === null) {
    return Result.err(
      new ApiError(409, "recording_not_ready", "The examination recording is not ready."),
    );
  }
  const range = parseRange(request.headers.get("Range"), head.value.size);
  if (!range.isOk()) return range;
  const object = await Result.tryPromise({
    try: () =>
      env.RECORDINGS.get(objectKey, range.value === null ? undefined : { range: range.value }),
    catch: examinationOperationFailed("get_examination_recording"),
  });
  if (!object.isOk()) return object;
  if (object.value === null) {
    return Result.err(
      new ApiError(409, "recording_not_ready", "The examination recording is not ready."),
    );
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
  return Result.ok({
    response: new Response(object.value.body, {
      status: range.value === null ? 200 : 206,
      headers,
    }),
    conversationId: stored.value.conversationId,
    outcome: range.value === null ? "recording_streamed" : "recording_range_streamed",
  });
}

export async function getExaminationSessionTranscript(
  examinationSessionId: string,
  user: AuthenticatedUser,
  env: Env,
): Promise<ApiResult<ExaminationApiResult>> {
  const stored = await ownedSession(examinationSessionId, user, env);
  if (!stored.isOk()) return stored;
  const artifact = await Result.tryPromise({
    try: () =>
      env.EXAM_DB.prepare(
        `SELECT transcript_key AS transcriptKey FROM transcription_jobs
         WHERE examination_session_id = ? AND status = 'complete'
           AND transcript_key IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(examinationSessionId)
        .first<{ transcriptKey: string }>(),
    catch: examinationOperationFailed("find_examination_transcript"),
  });
  if (!artifact.isOk()) return artifact;
  if (artifact.value === null) {
    return Result.err(
      new ApiError(409, "transcript_not_ready", "The examination transcript is not ready."),
    );
  }
  const transcriptKey = artifact.value.transcriptKey;
  const object = await Result.tryPromise({
    try: () => env.RECORDINGS.get(transcriptKey),
    catch: examinationOperationFailed("get_examination_transcript"),
  });
  if (!object.isOk()) return object;
  if (object.value === null) {
    return Result.err(
      new ApiError(409, "transcript_not_ready", "The examination transcript is not ready."),
    );
  }
  const transcriptObject = object.value;
  if (transcriptObject.size > MAX_TRANSCRIPT_BODY_BYTES) {
    return Result.err(
      new ApiError(500, "invalid_transcript", "The examination transcript is invalid."),
    );
  }
  const parsed = await Result.tryPromise({
    try: async () => transcriptSchema.safeParse(await transcriptObject.json()),
    catch: examinationOperationFailed("parse_examination_transcript"),
  });
  if (!parsed.isOk()) return parsed;
  if (!parsed.value.success || parsed.value.data.conversationId !== stored.value.conversationId) {
    return Result.err(
      new ApiError(500, "invalid_transcript", "The examination transcript is invalid."),
    );
  }
  return Result.ok({
    response: Response.json(parsed.value.data, {
      headers: { "Cache-Control": "private, no-store", ETag: transcriptObject.httpEtag },
    }),
    conversationId: stored.value.conversationId,
    outcome: "examination_transcript_returned",
  });
}

export async function getRealtimeCurrentQuestion(
  conversationId: string,
  user: AuthenticatedUser,
  env: Env,
): Promise<ApiResult<ExaminationApiResult>> {
  const owned = await ownedSession(conversationId, user, env);
  if (!owned.isOk()) return owned;
  const current = await Result.tryPromise({
    try: () => getCurrentExaminationQuestion(env.EXAM_DB, conversationId),
    catch: examinationOperationFailed("get_current_examination_question"),
  });
  if (!current.isOk()) return current;
  if (!current.value.isOk())
    return Result.err(examinationFailure("get_current_examination_question", current.value.error));
  if (current.value.value === null) {
    return Result.err(
      new ApiError(404, "examination_session_not_found", "Examination session not found."),
    );
  }
  return Result.ok(
    questionResult(current.value.value, conversationId, "current_question_returned"),
  );
}

export async function completeRealtimeCurrentQuestion(
  request: Request,
  conversationId: string,
  user: AuthenticatedUser,
  env: Env,
  dependencies: Pick<FoundationDependencies, "clock">,
): Promise<ApiResult<ExaminationApiResult>> {
  const owned = await ownedSession(conversationId, user, env);
  if (!owned.isOk()) return owned;
  const parsed = await readJson(request, completeExaminationQuestionRequestSchema);
  if (!parsed.isOk()) return parsed;
  const completed = await Result.tryPromise({
    try: () =>
      completeExaminationQuestion(env.EXAM_DB, {
        conversationId,
        ...parsed.value,
        completedAt: dependencies.clock.now(),
      }),
    catch: examinationOperationFailed("complete_current_examination_question"),
  });
  if (!completed.isOk()) return completed;
  if (!completed.value.isOk())
    return Result.err(
      examinationFailure("complete_current_examination_question", completed.value.error),
    );
  if (completed.value.value.status === "not_found") {
    return Result.err(
      new ApiError(404, "examination_session_not_found", "Examination session not found."),
    );
  }
  if (completed.value.value.status === "conflict") {
    return Result.err(
      new ApiError(
        409,
        "examination_question_conflict",
        "The current examination question changed.",
      ),
    );
  }
  return Result.ok(
    questionResult(
      completed.value.value.current,
      conversationId,
      completed.value.value.status === "advanced"
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
  const stored = await Result.tryPromise({
    try: () => findExaminationSessionById(env.EXAM_DB, examinationSessionId),
    catch: examinationOperationFailed("find_owned_examination_session"),
  });
  if (!stored.isOk()) return stored;
  if (stored.value === null || stored.value.userId !== user.id) {
    return Result.err(
      new ApiError(404, "examination_session_not_found", "Examination session not found."),
    );
  }
  return Result.ok(stored.value);
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
  const initialized = await Result.tryPromise({
    try: async (): Promise<AggregateStoreResult<InitializeResult>> =>
      deserializeResult<InitializeResult, AggregateStoreError>(
        await dependencies.conversations
          .get(conversationId)
          .initialize(
            value.conversationSessionId(conversationId),
            value.unixMillis(dependencies.clock.now()),
          ),
      ),
    catch: examinationOperationFailed("initialize_conversation"),
  });
  if (!initialized.isOk()) return initialized;
  if (!initialized.value.isOk())
    return Result.err(examinationFailure("initialize_conversation", initialized.value.error));
  if (initialized.value.value.status === "rejected") {
    return Result.err(
      new ApiError(409, "conversation_identity_conflict", "Conversation identity conflict."),
    );
  }
  return Result.ok({
    status: initialized.value.value.status,
    state: initialized.value.value.state,
  });
}

async function hydrateSession(
  stored: StoredExaminationSession,
  env: Env,
  dependencies: Pick<FoundationDependencies, "conversations">,
): Promise<ApiResult<ExaminationSession>> {
  const state = await readConversationState(stored.conversationId, dependencies);
  if (!state.isOk()) return state;
  const transcriptionStatus = await Result.tryPromise({
    try: () => findLatestTranscriptionStatus(env.EXAM_DB, stored.id),
    catch: examinationOperationFailed("find_transcription_status"),
  });
  if (!transcriptionStatus.isOk()) return transcriptionStatus;
  return Result.ok(
    publicExaminationSession(
      stored,
      state.value?.tag ?? null,
      state.value === null ? false : isRecordingAvailable(state.value),
      transcriptionStatus.value,
    ),
  );
}

async function readConversationState(
  conversationId: string,
  dependencies: Pick<FoundationDependencies, "conversations">,
): Promise<ApiResult<ConversationState | null>> {
  const stored = await Result.tryPromise({
    try: async (): Promise<AggregateStoreResult<ConversationState | null>> =>
      deserializeResult<ConversationState | null, AggregateStoreError>(
        await dependencies.conversations.get(conversationId).getState(),
      ),
    catch: examinationOperationFailed("read_conversation_state"),
  });
  if (!stored.isOk()) return stored;
  return stored.value.isOk()
    ? Result.ok(stored.value.value)
    : Result.err(examinationFailure("read_conversation_state", stored.value.error));
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
    return Result.err(
      new ApiError(415, "unsupported_media_type", "Content-Type must be application/json."),
    );
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_EXAMINATION_BODY_BYTES) {
    return Result.err(
      new ApiError(413, "examination_request_too_large", "The request body is too large."),
    );
  }
  const body = await Result.tryPromise({
    try: () => request.arrayBuffer(),
    catch: examinationOperationFailed("read_examination_request_body"),
  });
  if (!body.isOk()) return body;
  if (body.value.byteLength > MAX_EXAMINATION_BODY_BYTES) {
    return Result.err(
      new ApiError(413, "examination_request_too_large", "The request body is too large."),
    );
  }
  const decoded = Result.try({
    try: () => JSON.parse(new TextDecoder().decode(body.value)) as unknown,
    catch: () => new ApiError(400, "invalid_examination_request", "The request body is invalid."),
  });
  if (!decoded.isOk()) return decoded;
  const parsed = schema.safeParse(decoded.value);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(new ApiError(400, "invalid_examination_request", "The request body is invalid."));
}

function examinationOperationFailed(operation: string): (cause: unknown) => ApiError {
  return (cause) => examinationFailure(operation, cause);
}

function examinationFailure(operation: string, cause: unknown): ApiError {
  return new ApiError(
    500,
    "examination_operation_failed",
    "The examination operation could not be completed.",
    {},
    cause,
    { component: "examination", operation },
  );
}

function parseRange(
  header: string | null,
  size: number,
): ApiResult<{ readonly offset: number; readonly length: number } | null> {
  if (header === null) return Result.ok(null);
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) {
    return Result.err(rangeNotSatisfiable(size));
  }
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "") {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || size === 0) {
      return Result.err(rangeNotSatisfiable(size));
    }
    const length = Math.min(suffixLength, size);
    return Result.ok({ offset: size - length, length });
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
    return Result.err(rangeNotSatisfiable(size));
  }
  const end = Math.min(requestedEnd, size - 1);
  return Result.ok({ offset, length: end - offset + 1 });
}

function rangeNotSatisfiable(size: number): ApiError {
  return new ApiError(416, "recording_range_not_satisfiable", "The recording range is invalid.", {
    "Content-Range": `bytes */${size}`,
  });
}
