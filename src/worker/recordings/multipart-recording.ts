/** Coordinates browser-recorded mixed audio with Cloudflare R2 multipart uploads. */
import { deserializeResult } from "@ai-oral-exam/conversation-contract";
import { Result } from "better-result";

import { MAXIMUM_LIVE_DURATION_MS } from "../../domain/conversation-deadlines";
import {
  ConversationEventType,
  ConversationStateTag,
  value,
  type ConversationState,
} from "../../domain/conversation-state-machine";
import type {
  AggregateStoreError,
  AggregateStoreResult,
} from "../../durable-object/conversation-aggregate-store";
import { applyConversationEvent } from "../conversations/apply-event-retry";
import { enqueueCompletedRecordingTranscription } from "../transcription/enqueue-transcription";
import { ApiError } from "../http/api-errors";
import type { FoundationDependencies } from "../ports/foundation";

const ARTIFACT_UPLOAD_WINDOW_MS = 10 * 60_000;
const ALLOWED_RECORDING_TYPES = new Set([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/ogg",
  "audio/ogg;codecs=opus",
  "audio/mp4",
]);

export interface RecordingOperationResult {
  readonly response: Response;
  readonly conversationId: string;
  readonly state: ConversationState;
  readonly outcome: string;
}

export async function beginRecording(
  request: Request,
  conversationId: string,
  env: Env,
  dependencies: FoundationDependencies,
): Promise<Result<RecordingOperationResult, ApiError>> {
  const contentType = await readContentType(request);
  if (!contentType.isOk()) return contentType;
  const initial = await readState(conversationId, dependencies);
  if (!initial.isOk()) return initial;
  if (initial.value.tag !== ConversationStateTag.Starting) {
    return Result.err(
      new ApiError(409, "conversation_not_starting", "Conversation is not starting."),
    );
  }

  const objectKey = recordingObjectKey(conversationId, contentType.value);
  const created = await Result.tryPromise({
    try: () =>
      env.RECORDINGS.createMultipartUpload(objectKey, {
        httpMetadata: { contentType: contentType.value, cacheControl: "private, no-store" },
      }),
    catch: recordingFailure("create_multipart_upload"),
  });
  if (!created.isOk()) return created;
  const upload = created.value;
  const recordingId = upload.uploadId;
  const stub = dependencies.conversations.get(conversationId);
  const now = dependencies.clock.now();
  const events = [
    {
      type: ConversationEventType.TransportConnected,
      eventId: `browser:realtime-connected:${recordingId}`,
      at: value.unixMillis(now),
      epoch: 1,
    },
    {
      type: ConversationEventType.RecordingStarted,
      eventId: `browser:recording-started:${recordingId}`,
      at: value.unixMillis(now),
      recordingId: value.recordingId(recordingId),
    },
    {
      type: ConversationEventType.SessionStarted,
      eventId: `browser:session-started:${recordingId}`,
      at: value.unixMillis(now),
      epoch: 1,
      maximumEndAt: value.unixMillis(now + MAXIMUM_LIVE_DURATION_MS),
    },
  ] as const;
  let state: ConversationState = initial.value;
  for (const event of events) {
    // oxlint-disable-next-line no-await-in-loop -- domain events must advance one revision at a time.
    const applied = await applyConversationEvent(stub, state, event);
    if (!applied.isOk()) {
      // oxlint-disable-next-line no-await-in-loop -- abort belongs to the failed sequential transition.
      await Result.tryPromise({ try: () => upload.abort(), catch: () => undefined });
      return Result.err(recordingFailure("begin_recording_transition")(applied.error));
    }
    state = applied.value;
  }
  return Result.ok({
    response: Response.json({ recordingId, objectKey, uploadId: upload.uploadId }),
    conversationId,
    state,
    outcome: "recording_started",
  });
}

export async function beginRecordingUpload(
  request: Request,
  conversationId: string,
  dependencies: FoundationDependencies,
): Promise<Result<RecordingOperationResult, ApiError>> {
  const details = await readUploadDetails(request, conversationId);
  if (!details.isOk()) return details;
  const initial = await readState(conversationId, dependencies);
  if (!initial.isOk()) return initial;
  if (initial.value.tag !== ConversationStateTag.Ending) {
    return Result.err(new ApiError(409, "conversation_not_ending", "Conversation is not ending."));
  }
  const now = dependencies.clock.now();
  const { uploadId, objectKey } = details.value;
  const events = [
    {
      type: ConversationEventType.SessionClosed,
      eventId: `browser:session-closed:${uploadId}`,
      at: value.unixMillis(now),
      epoch: 1,
    },
    {
      type: ConversationEventType.RecordingUploadStarted,
      eventId: `browser:recording-upload:${uploadId}`,
      at: value.unixMillis(now),
      recordingId: value.recordingId(uploadId),
      expectedR2Key: value.r2ObjectKey(objectKey),
      artifactDeadlineAt: value.unixMillis(now + ARTIFACT_UPLOAD_WINDOW_MS),
    },
  ] as const;
  let state: ConversationState = initial.value;
  const stub = dependencies.conversations.get(conversationId);
  for (const event of events) {
    // oxlint-disable-next-line no-await-in-loop -- domain events must advance one revision at a time.
    const applied = await applyConversationEvent(stub, state, event);
    if (!applied.isOk())
      return Result.err(recordingFailure("begin_recording_upload")(applied.error));
    state = applied.value;
  }
  return Result.ok({
    response: new Response(null, { status: 204 }),
    conversationId,
    state,
    outcome: "recording_upload_started",
  });
}

export async function uploadRecordingPart(
  request: Request,
  conversationId: string,
  partNumber: number,
  env: Env,
): Promise<Result<Response, ApiError>> {
  const uploadId = uploadIdFromUrl(request.url);
  if (!uploadId.isOk()) return uploadId;
  if (
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > 10_000 ||
    request.body === null
  ) {
    return Result.err(
      new ApiError(400, "invalid_recording_part", "The recording part is invalid."),
    );
  }
  const objectKey = new URL(request.url).searchParams.get("objectKey");
  if (objectKey === null || !isRecordingKey(conversationId, objectKey)) {
    return Result.err(
      new ApiError(400, "invalid_object_key", "The recording object key is invalid."),
    );
  }
  const upload = env.RECORDINGS.resumeMultipartUpload(objectKey, uploadId.value);
  const uploaded = await Result.tryPromise({
    try: () => upload.uploadPart(partNumber, request.body!),
    catch: recordingFailure("upload_part"),
  });
  return uploaded.isOk() ? Result.ok(Response.json(uploaded.value)) : uploaded;
}

export async function completeRecordingUpload(
  request: Request,
  conversationId: string,
  env: Env,
  dependencies: FoundationDependencies,
): Promise<Result<RecordingOperationResult, ApiError>> {
  const body = await readCompletion(request);
  if (!body.isOk()) return body;
  const initial = await readState(conversationId, dependencies);
  if (!initial.isOk()) return initial;
  if (initial.value.data.artifact.status === "ready") {
    const artifact = initial.value.data.artifact;
    if (body.value.uploadId !== artifact.recordingId || body.value.objectKey !== artifact.r2Key) {
      return Result.err(
        new ApiError(409, "recording_not_uploading", "The recording is not uploading."),
      );
    }
    const transcription = await persistTranscriptionJob(
      env,
      conversationId,
      artifact.r2Key,
      artifact.r2Etag,
      artifact.readyAt,
    );
    if (!transcription.isOk()) return transcription;
    return completedRecordingResult(
      conversationId,
      artifact.r2Key,
      artifact.r2Etag,
      initial.value,
      "recording_upload_completion_replayed",
    );
  }
  if (
    initial.value.tag !== ConversationStateTag.Ending ||
    initial.value.data.artifact.status !== "uploading"
  ) {
    return Result.err(
      new ApiError(409, "recording_not_uploading", "The recording is not uploading."),
    );
  }
  const objectKey = initial.value.data.artifact.expectedR2Key;
  if (body.value.objectKey !== objectKey) {
    return Result.err(
      new ApiError(409, "recording_key_mismatch", "The recording object key does not match."),
    );
  }
  const upload = env.RECORDINGS.resumeMultipartUpload(objectKey, body.value.uploadId);
  const completed = await Result.tryPromise({
    try: () => upload.complete(body.value.parts),
    catch: recordingFailure("complete_multipart_upload"),
  });
  if (!completed.isOk()) return completed;
  const now = dependencies.clock.now();
  const ready = await applyConversationEvent(
    dependencies.conversations.get(conversationId),
    initial.value,
    {
      type: ConversationEventType.RecordingArtifactVerified,
      eventId: `browser:recording-complete:${body.value.uploadId}`,
      at: value.unixMillis(now),
      recordingId: value.recordingId(body.value.uploadId),
      r2Key: value.r2ObjectKey(objectKey),
      r2Etag: value.r2Etag(completed.value.etag),
    },
  );
  if (!ready.isOk()) return Result.err(recordingFailure("verify_recording")(ready.error));

  const transcription = await persistTranscriptionJob(
    env,
    conversationId,
    objectKey,
    completed.value.etag,
    now,
  );
  if (!transcription.isOk()) return transcription;
  return completedRecordingResult(
    conversationId,
    objectKey,
    completed.value.etag,
    ready.value,
    "recording_upload_completed",
  );
}

async function persistTranscriptionJob(
  env: Env,
  conversationId: string,
  objectKey: string,
  etag: string,
  createdAt: number,
) {
  const transcription = await Result.tryPromise({
    try: () =>
      enqueueCompletedRecordingTranscription(env, {
        conversationId,
        objectKey,
        etag,
        createdAt,
      }),
    catch: recordingFailure("persist_transcription_job"),
  });
  if (transcription.isOk()) {
    console.log({
      kind: "transcription_enqueue",
      conversationId,
      outcome: transcription.value,
    });
  }
  return transcription;
}

function completedRecordingResult(
  conversationId: string,
  objectKey: string,
  etag: string,
  state: ConversationState,
  outcome: "recording_upload_completed" | "recording_upload_completion_replayed",
): Result<RecordingOperationResult, ApiError> {
  return Result.ok({
    response: Response.json({ objectKey, etag }),
    conversationId,
    state,
    outcome,
  });
}

export async function abortRecordingUpload(
  request: Request,
  conversationId: string,
  env: Env,
): Promise<Result<Response, ApiError>> {
  const details = await readUploadDetails(request, conversationId);
  if (!details.isOk()) return details;
  const upload = env.RECORDINGS.resumeMultipartUpload(
    details.value.objectKey,
    details.value.uploadId,
  );
  const aborted = await Result.tryPromise({
    try: () => upload.abort(),
    catch: recordingFailure("abort_multipart_upload"),
  });
  return aborted.isOk() ? Result.ok(new Response(null, { status: 204 })) : aborted;
}

async function readState(
  conversationId: string,
  dependencies: FoundationDependencies,
): Promise<Result<ConversationState, ApiError>> {
  const stored = await Result.tryPromise({
    try: async (): Promise<AggregateStoreResult<ConversationState | null>> =>
      deserializeResult<ConversationState | null, AggregateStoreError>(
        await dependencies.conversations.get(conversationId).getState(),
      ),
    catch: recordingFailure("read_conversation"),
  });
  if (!stored.isOk()) return stored;
  if (!stored.value.isOk())
    return Result.err(recordingFailure("read_conversation")(stored.value.error));
  return stored.value.value === null
    ? Result.err(new ApiError(404, "conversation_not_found", "Conversation not found."))
    : Result.ok(stored.value.value);
}

async function readContentType(request: Request): Promise<Result<string, ApiError>> {
  const json = await readJson(request);
  if (!json.isOk()) return json;
  const contentType = json.value.contentType;
  return typeof contentType === "string" && ALLOWED_RECORDING_TYPES.has(contentType)
    ? Result.ok(contentType)
    : Result.err(
        new ApiError(400, "invalid_recording_type", "The recording type is not supported."),
      );
}

async function readUploadDetails(
  request: Request,
  conversationId: string,
): Promise<Result<{ uploadId: string; objectKey: string }, ApiError>> {
  const json = await readJson(request);
  const uploadId = json.isOk() ? json.value.uploadId : undefined;
  const objectKey = json.isOk() ? json.value.objectKey : undefined;
  return typeof uploadId === "string" &&
    uploadId.length > 0 &&
    uploadId.length <= 1024 &&
    typeof objectKey === "string" &&
    isRecordingKey(conversationId, objectKey)
    ? Result.ok({ uploadId, objectKey })
    : Result.err(new ApiError(400, "invalid_upload_id", "The upload identifier is invalid."));
}

async function readCompletion(
  request: Request,
): Promise<Result<{ uploadId: string; objectKey: string; parts: R2UploadedPart[] }, ApiError>> {
  const json = await readJson(request);
  if (!json.isOk()) return json;
  const uploadId = json.value.uploadId;
  const objectKey = json.value.objectKey;
  const parts = json.value.parts;
  if (
    typeof uploadId !== "string" ||
    uploadId.length === 0 ||
    typeof objectKey !== "string" ||
    !Array.isArray(parts) ||
    parts.length === 0 ||
    !parts.every(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        "partNumber" in part &&
        Number.isInteger(part.partNumber) &&
        part.partNumber > 0 &&
        "etag" in part &&
        typeof part.etag === "string" &&
        part.etag.length > 0,
    )
  ) {
    return Result.err(
      new ApiError(400, "invalid_recording_completion", "The recording completion is invalid."),
    );
  }
  return Result.ok({ uploadId, objectKey, parts: parts as R2UploadedPart[] });
}

async function readJson(request: Request): Promise<Result<Record<string, unknown>, ApiError>> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return Result.err(
      new ApiError(415, "unsupported_media_type", "Content-Type must be application/json."),
    );
  }
  const parsed = await Result.tryPromise({
    try: () => request.json() as Promise<unknown>,
    catch: () => new ApiError(400, "invalid_json", "The request body is invalid."),
  });
  if (!parsed.isOk()) return parsed;
  return typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value)
    ? Result.ok(parsed.value as Record<string, unknown>)
    : Result.err(new ApiError(400, "invalid_json", "The request body is invalid."));
}

function uploadIdFromUrl(url: string): Result<string, ApiError> {
  const uploadId = new URL(url).searchParams.get("uploadId");
  return uploadId !== null && uploadId.length > 0 && uploadId.length <= 1024
    ? Result.ok(uploadId)
    : Result.err(new ApiError(400, "invalid_upload_id", "The upload identifier is invalid."));
}

function recordingObjectKey(conversationId: string, contentType: string): string {
  const extension = contentType.startsWith("audio/ogg")
    ? "ogg"
    : contentType.startsWith("audio/mp4")
      ? "m4a"
      : "webm";
  return `conversations/${conversationId}/recording.${extension}`;
}

function isRecordingKey(conversationId: string, objectKey: string): boolean {
  return ["webm", "ogg", "m4a"].some(
    (extension) => objectKey === `conversations/${conversationId}/recording.${extension}`,
  );
}

function recordingFailure(operation: string): (cause: unknown) => ApiError {
  return (cause) =>
    new ApiError(
      500,
      "recording_operation_failed",
      "The recording operation could not be completed.",
      {},
      cause,
      { component: "recording", operation },
    );
}
