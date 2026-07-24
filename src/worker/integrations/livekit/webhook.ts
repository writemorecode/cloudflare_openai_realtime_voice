/**
 * LiveKit-to-control-plane integration boundary.
 *
 * Verified LiveKit payloads are decoded into internal observations before this executor performs
 * Durable Object or R2 effects. Completed R2 objects are verified before the aggregate can mark an
 * artifact ready.
 */
import { ALARM_SHUTDOWN_GRACE_MS } from "../../../domain/conversation-deadlines";
import { TRANSPORT_RECOVERY_WINDOW_MS } from "../../../domain/conversation-deadlines";
import {
  ArtifactStatus,
  ConversationEventType,
  ConversationStateTag,
  TransportStatus,
  value,
  type ConversationEvent,
  type ConversationState,
} from "../../../domain/conversation-state-machine";
import type {
  ApplyEventResult,
  ConversationSession,
} from "../../../durable-object/conversation-session";
import { ApiError } from "../../http/api-errors";
import type { LiveKitWebhookDependencies } from "../../ports/foundation";
import { err, ok, tryCatch, type Result } from "@ai-oral-exam/result";
import { applyIntegrationEventWithRetry } from "./integration-event-retry";
import { reconcileCompositeReadiness } from "./readiness";
import {
  completedEgressRecording,
  decideArtifactFailure,
  decideEgressProgress,
  decideMediaObservationKind,
  decideRoomFinished,
  decodeLiveKitWebhook,
  egressFailureCode,
  isNegativeMediaObservation,
  type DecodedEgressWebhook,
  type DecodedLiveKitWebhook,
  type DecodedMediaWebhook,
  type LiveKitWebhookDecisionError,
  type LiveKitWebhookDecodeError,
} from "./webhook-decisions";

const LIVEKIT_WEBHOOK_CONTENT_TYPE = "application/webhook+json";
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_LENGTH = 4096;
const ARTIFACT_UPLOAD_WINDOW_MS = 2 * 60_000;

export const LIVEKIT_ROOM_PREFIX = "conversation-";

export interface LiveKitWebhookResult {
  readonly conversationId: string;
  readonly state: ConversationState;
  readonly outcome: string;
}

interface TranslatedWebhookResult {
  readonly state: ConversationState;
  readonly outcome: string;
}

export async function handleLiveKitWebhook(
  request: Request,
  env: Env,
  dependencies: LiveKitWebhookDependencies,
): Promise<Result<LiveKitWebhookResult, ApiError>> {
  const validRequest = validateWebhookRequest(request);
  if (!validRequest.ok) return validRequest;
  const validConfiguration = validateWebhookConfiguration(env);
  if (!validConfiguration.ok) return validConfiguration;

  const body = await tryCatch(() => request.text(), webhookOperationFailed);
  if (!body.ok) return body;
  if (new TextEncoder().encode(body.value).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return err(new ApiError(413, "livekit_webhook_too_large", "The webhook body is too large."));
  }

  const received = await tryCatch(
    () =>
      dependencies.liveKitWebhook.verify(
        body.value,
        request.headers.get("Authorization") ?? undefined,
      ),
    (cause) =>
      new ApiError(
        401,
        "invalid_livekit_webhook",
        "The LiveKit webhook signature is invalid.",
        {},
        cause,
      ),
  );
  if (!received.ok) return received;
  const decoded = decodeLiveKitWebhook(received.value);
  if (!decoded.ok) return err(webhookDecodeError(decoded.error));
  const observation = decoded.value;
  const conversationId = observation.conversationId;
  const stub = dependencies.conversations.get(conversationId);
  const initial = await tryCatch(
    async (): Promise<ConversationState | null> => await stub.getState(),
    webhookOperationFailed,
  );
  if (!initial.ok) return initial;
  if (initial.value === null) {
    return err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  const correlatedEgress = await validateEgressCorrelation(observation, stub);
  if (!correlatedEgress.ok) return correlatedEgress;

  const result = await translateWebhookEvent(observation, initial.value, stub, dependencies);
  if (!result.ok) return result;
  console.log(
    JSON.stringify({
      kind: "livekit_webhook_processed",
      eventId: observation.eventId,
      eventType: observation.eventType,
      conversationId,
      outcome: result.value.outcome,
      resultingState: result.value.state.tag,
      resultingRevision: result.value.state.revision,
    }),
  );
  return ok({ conversationId, ...result.value });
}

function validateWebhookRequest(request: Request): Result<void, ApiError> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== LIVEKIT_WEBHOOK_CONTENT_TYPE) {
    return err(
      new ApiError(
        415,
        "unsupported_media_type",
        `Content-Type must be ${LIVEKIT_WEBHOOK_CONTENT_TYPE}.`,
      ),
    );
  }
  const authorization = request.headers.get("Authorization");
  if (authorization === null || authorization.length === 0) {
    return err(new ApiError(401, "invalid_livekit_webhook", "The LiveKit signature is required."));
  }
  if (authorization.length > MAX_AUTHORIZATION_LENGTH) {
    return err(new ApiError(431, "request_header_too_large", "A request header is too large."));
  }
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      return err(new ApiError(400, "invalid_content_length", "Content-Length is invalid."));
    }
    if (length > MAX_WEBHOOK_BODY_BYTES) {
      return err(new ApiError(413, "livekit_webhook_too_large", "The webhook body is too large."));
    }
  }
  return ok(undefined);
}

function validateWebhookConfiguration(env: Env): Result<void, ApiError> {
  if (env.LIVEKIT_API_KEY.length === 0 || env.LIVEKIT_API_SECRET.length === 0) {
    return err(
      new ApiError(500, "livekit_webhook_not_configured", "The LiveKit webhook is not configured."),
    );
  }
  return ok(undefined);
}

async function translateWebhookEvent(
  observation: DecodedLiveKitWebhook,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  dependencies: LiveKitWebhookDependencies,
): Promise<Result<TranslatedWebhookResult, ApiError>> {
  switch (observation.kind) {
    case "egress_progress":
      return handleEgressProgress(observation, state, stub, dependencies);
    case "egress_ended":
      return handleEgressEnded(observation, state, stub, dependencies);
    case "room_finished":
      return handleRoomFinished(observation, state, stub, dependencies);
    case "media":
      return handleMediaObservation(observation, state, stub, dependencies);
    case "acknowledged":
      return ok({ state, outcome: "observation_acknowledged" });
  }
}

async function handleEgressProgress(
  observation: DecodedEgressWebhook,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  dependencies: Pick<LiveKitWebhookDependencies, "clock">,
): Promise<Result<TranslatedWebhookResult, ApiError>> {
  const decision = decideEgressProgress(observation, state);
  if (!decision.ok) return err(webhookDecisionError(decision.error));
  if (decision.value.kind === "acknowledge") {
    return ok({ state, outcome: decision.value.outcome });
  }
  if (decision.value.kind === "fail_artifact") {
    return failArtifact(observation, state, stub, decision.value.errorCode, dependencies.clock);
  }
  const observedAt = dependencies.clock.now();
  const applied = await applyIntegrationEvent(stub, state, {
    type: ConversationEventType.RecordingStarted,
    eventId: domainEventId(observation, "recording-started"),
    at: value.unixMillis(observedAt),
    recordingId: value.recordingId(decision.value.recordingId),
  });
  if (!applied.ok) return applied;
  const reconciled = await reconcileCompositeReadiness(stub, observedAt);
  if (!reconciled.ok) return reconciled;
  return ok({ state: reconciled.value, outcome: "recording_started" });
}

async function handleMediaObservation(
  observation: DecodedMediaWebhook,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  dependencies: Pick<LiveKitWebhookDependencies, "clock">,
): Promise<Result<TranslatedWebhookResult, ApiError>> {
  const evidence = await tryCatch(() => stub.getLiveKitTransportEvidence(), webhookOperationFailed);
  if (!evidence.ok) return evidence;
  const kind = decideMediaObservationKind(
    observation,
    evidence.value?.agentParticipantIdentity ?? null,
  );
  if (kind === null) return ok({ state, outcome: "observation_acknowledged" });
  const transport = state.data.transport;
  if (transport.status === TransportStatus.Idle) {
    return ok({ state, outcome: "observation_before_start" });
  }
  const recorded = await tryCatch(
    () =>
      stub.recordLiveKitMediaObservation({
        eventId: observation.eventId,
        kind,
        participantIdentity: observation.participantIdentity,
        roomName: observation.roomName,
        transportEpoch: transport.epoch,
      }),
    webhookOperationFailed,
  );
  if (!recorded.ok) return recorded;
  if (recorded.value.outcome === "rejected") {
    if (recorded.value.reason === null) {
      return err(webhookOperationFailed(new Error("Rejected observation omitted its reason.")));
    }
    return err(mediaObservationCorrelationError(recorded.value.reason));
  }

  if (
    isNegativeMediaObservation(kind) &&
    state.tag === ConversationStateTag.Live &&
    state.data.transport.status === TransportStatus.Connected
  ) {
    const at = dependencies.clock.now();
    const interrupted = await applyIntegrationEvent(stub, state, {
      type: ConversationEventType.TransportInterrupted,
      eventId: domainEventId(observation, "transport-interrupted"),
      at: value.unixMillis(at),
      epoch: transport.epoch,
      errorCode: value.errorCode("transport.livekit_media_interrupted"),
      recoveryDeadlineAt: value.unixMillis(at + TRANSPORT_RECOVERY_WINDOW_MS),
    });
    if (!interrupted.ok) return interrupted;
    return ok({ state: interrupted.value, outcome: "transport_interrupted" });
  }

  const reconciled = await reconcileCompositeReadiness(stub, dependencies.clock.now());
  if (!reconciled.ok) return reconciled;
  return ok({
    state: reconciled.value,
    outcome:
      recorded.value.outcome === "duplicate" ? "observation_duplicate" : "readiness_reconciled",
  });
}

async function handleEgressEnded(
  observation: DecodedEgressWebhook,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  dependencies: Pick<LiveKitWebhookDependencies, "clock" | "recordings">,
): Promise<Result<TranslatedWebhookResult, ApiError>> {
  const failureCode = egressFailureCode(observation.status);
  if (failureCode !== null) {
    return failArtifact(observation, state, stub, failureCode, dependencies.clock);
  }
  if (observation.status !== "complete") {
    return failArtifact(
      observation,
      state,
      stub,
      "artifact.livekit_egress_incomplete",
      dependencies.clock,
    );
  }

  const recording = completedEgressRecording(observation);
  if (!recording.ok) {
    return recording.error === "invalid_output_count" || recording.error === "invalid_output_key"
      ? failArtifact(
          observation,
          state,
          stub,
          "artifact.livekit_output_invalid",
          dependencies.clock,
        )
      : err(webhookDecisionError(recording.error));
  }
  const { recordingId, r2Key } = recording.value;
  let current = state;
  const provisioning = await tryCatch(() => stub.getLiveKitProvisioning(), webhookOperationFailed);
  if (!provisioning.ok) return provisioning;
  if (provisioning.value === null || provisioning.value.expectedR2Key !== r2Key) {
    return failArtifact(
      observation,
      current,
      stub,
      "artifact.livekit_output_mismatch",
      dependencies.clock,
    );
  }

  if (current.data.artifact.status === ArtifactStatus.Pending) {
    return failArtifact(
      observation,
      current,
      stub,
      "artifact.livekit_recording_not_observed",
      dependencies.clock,
    );
  }

  if (current.data.artifact.status === ArtifactStatus.Recording) {
    if (current.tag !== ConversationStateTag.Ending) {
      return failArtifact(
        observation,
        current,
        stub,
        "artifact.livekit_egress_ended_early",
        dependencies.clock,
      );
    }
    const uploadStartedAt = dependencies.clock.now();
    const applied = await applyIntegrationEvent(stub, current, {
      type: ConversationEventType.RecordingUploadStarted,
      eventId: domainEventId(observation, "recording-upload-started"),
      at: value.unixMillis(uploadStartedAt),
      recordingId: value.recordingId(recordingId),
      expectedR2Key: value.r2ObjectKey(r2Key),
      artifactDeadlineAt: value.unixMillis(uploadStartedAt + ARTIFACT_UPLOAD_WINDOW_MS),
    });
    if (!applied.ok) return applied;
    current = applied.value;
  }

  if (current.data.artifact.status === ArtifactStatus.Ready) {
    return ok({ state: current, outcome: "artifact_already_ready" });
  }
  if (current.data.artifact.status !== ArtifactStatus.Uploading) {
    return ok({ state: current, outcome: "artifact_not_required" });
  }
  if (
    current.data.artifact.recordingId !== recordingId ||
    current.data.artifact.expectedR2Key !== r2Key
  ) {
    return failArtifact(
      observation,
      current,
      stub,
      "artifact.livekit_output_mismatch",
      dependencies.clock,
    );
  }

  const object = await tryCatch(() => dependencies.recordings.head(r2Key), webhookOperationFailed);
  if (!object.ok) return object;
  if (object.value === null || object.value.size === 0) {
    return err(
      new ApiError(
        503,
        "recording_not_available",
        "The recording is not yet available in object storage.",
        { "Retry-After": "2" },
      ),
    );
  }

  const verified = await applyIntegrationEvent(stub, current, {
    type: ConversationEventType.RecordingArtifactVerified,
    eventId: domainEventId(observation, "recording-artifact-verified"),
    at: value.unixMillis(dependencies.clock.now()),
    recordingId: value.recordingId(recordingId),
    r2Key: value.r2ObjectKey(r2Key),
    r2Etag: value.r2Etag(object.value.etag),
  });
  if (!verified.ok) return verified;
  return ok({ state: verified.value, outcome: "recording_artifact_verified" });
}

async function validateEgressCorrelation(
  observation: DecodedLiveKitWebhook,
  stub: DurableObjectStub<ConversationSession>,
): Promise<Result<void, ApiError>> {
  if (observation.kind !== "egress_progress" && observation.kind !== "egress_ended") {
    return ok(undefined);
  }
  const provisioning = await tryCatch(() => stub.getLiveKitProvisioning(), webhookOperationFailed);
  if (!provisioning.ok) return provisioning;
  if (provisioning.value === null || provisioning.value.egressId !== observation.egressId) {
    return err(
      new ApiError(409, "livekit_egress_mismatch", "The LiveKit egress does not correlate."),
    );
  }
  return ok(undefined);
}

async function handleRoomFinished(
  observation: Extract<DecodedLiveKitWebhook, { kind: "room_finished" }>,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  dependencies: Pick<LiveKitWebhookDependencies, "clock">,
): Promise<Result<TranslatedWebhookResult, ApiError>> {
  const decision = decideRoomFinished(state);
  if (decision.kind === "acknowledge") {
    return ok({ state, outcome: decision.outcome });
  }
  const next = await applyIntegrationEvent(stub, state, {
    type: ConversationEventType.SessionClosed,
    eventId: domainEventId(observation, "session-closed"),
    at: value.unixMillis(dependencies.clock.now()),
    epoch: decision.epoch,
  });
  if (!next.ok) return next;
  return ok({ state: next.value, outcome: "session_closed" });
}

async function failArtifact(
  observation: DecodedEgressWebhook,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  errorCode: string,
  clock: LiveKitWebhookDependencies["clock"],
): Promise<Result<TranslatedWebhookResult, ApiError>> {
  const decision = decideArtifactFailure(observation, state, errorCode);
  if (decision.kind === "acknowledge") {
    return ok({ state, outcome: decision.outcome });
  }
  const observedAt = clock.now();
  const next = await applyIntegrationEvent(stub, state, {
    type: ConversationEventType.ArtifactFailed,
    eventId: domainEventId(observation, "artifact-failed"),
    at: value.unixMillis(observedAt),
    recordingId: decision.recordingId === null ? null : value.recordingId(decision.recordingId),
    errorCode: value.errorCode(decision.errorCode),
    endingDeadlineAt: value.unixMillis(observedAt + ALARM_SHUTDOWN_GRACE_MS),
  });
  if (!next.ok) return next;
  return ok({ state: next.value, outcome: "artifact_failed" });
}

async function applyIntegrationEvent(
  stub: DurableObjectStub<ConversationSession>,
  initial: ConversationState,
  event: ConversationEvent,
): Promise<Result<ConversationState, ApiError>> {
  return applyIntegrationEventWithRetry(stub, initial, event, {
    rejected: transitionError,
    exhausted: () =>
      new ApiError(409, "conversation_revision_conflict", "Conversation state changed."),
    failed: (cause) =>
      new ApiError(
        500,
        "livekit_event_apply_failed",
        "The LiveKit event could not be applied.",
        {},
        cause,
      ),
  });
}

function transitionError(result: Extract<ApplyEventResult, { outcome: "rejected" }>): ApiError {
  switch (result.reason) {
    case "not_initialized":
      return new ApiError(404, "conversation_not_found", "Conversation not found.");
    case "revision_conflict":
      return new ApiError(409, "conversation_revision_conflict", "Conversation state changed.");
    case "illegal_transition":
    case "guard_failed":
      return new ApiError(
        409,
        "livekit_event_conflict",
        "The LiveKit event conflicts with conversation state.",
      );
  }
}

function webhookDecodeError(error: LiveKitWebhookDecodeError): ApiError {
  switch (error) {
    case "invalid_event":
      return new ApiError(400, "invalid_livekit_event", "The LiveKit event ID is invalid.");
    case "event_type_missing":
      return new ApiError(400, "invalid_livekit_event", "The LiveKit event type is missing.");
    case "room_missing":
      return new ApiError(400, "livekit_room_missing", "The LiveKit room is missing.");
    case "room_mismatch":
      return new ApiError(400, "livekit_room_mismatch", "The LiveKit room does not match.");
    case "invalid_room":
      return new ApiError(400, "invalid_livekit_room", "The LiveKit room name is invalid.");
    case "egress_missing":
      return new ApiError(400, "livekit_egress_missing", "The LiveKit egress payload is missing.");
    case "participant_missing":
      return new ApiError(
        400,
        "livekit_participant_missing",
        "The LiveKit participant is missing.",
      );
    case "participant_identity_missing":
      return new ApiError(
        400,
        "livekit_participant_identity_missing",
        "The LiveKit participant identity is missing.",
      );
    case "unsupported_event":
      return new ApiError(
        400,
        "unsupported_livekit_event",
        "The LiveKit event type is unsupported.",
      );
  }
}

function webhookDecisionError(error: LiveKitWebhookDecisionError): ApiError {
  switch (error) {
    case "conversation_not_ready":
      return new ApiError(
        409,
        "conversation_not_ready",
        "Conversation is not ready for recording.",
      );
    case "invalid_egress":
      return new ApiError(400, "invalid_livekit_egress", "The LiveKit egress ID is invalid.");
    case "invalid_output_count":
      return new ApiError(400, "invalid_livekit_output", "Expected one LiveKit recording output.");
    case "invalid_output_key":
      return new ApiError(400, "invalid_livekit_output", "The recording object key is invalid.");
  }
}

function webhookOperationFailed(cause: unknown): ApiError {
  return new ApiError(
    500,
    "livekit_webhook_operation_failed",
    "The LiveKit webhook could not be processed.",
    {},
    cause,
  );
}

function mediaObservationCorrelationError(
  reason: "not_provisioned" | "room_mismatch" | "epoch_mismatch",
): ApiError {
  return reason === "not_provisioned"
    ? new ApiError(
        503,
        "livekit_observation_provisioning_pending",
        "LiveKit observation correlation is not ready.",
        { "Retry-After": "1" },
      )
    : new ApiError(
        409,
        "livekit_observation_correlation_failed",
        "The LiveKit observation did not correlate.",
      );
}

function domainEventId(observation: DecodedLiveKitWebhook, suffix: string): string {
  return `livekit:webhook:${observation.eventId}:${suffix}`;
}
