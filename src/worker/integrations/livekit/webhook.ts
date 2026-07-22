/**
 * LiveKit-to-control-plane integration boundary.
 *
 * LiveKit SDK payloads terminate here: signatures and correlation fields are validated, provider
 * observations are translated to provider-neutral domain events, and completed R2 objects are
 * verified before the Durable Object can mark an artifact ready.
 */
import { ParticipantInfo_Kind, TrackSource, TrackType } from "@livekit/protocol";
import { EgressStatus, type WebhookEvent } from "livekit-server-sdk";

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
  LiveKitMediaObservationKind,
} from "../../../durable-object/conversation-session";
import { ApiError } from "../../http/api-errors";
import type { LiveKitWebhookDependencies } from "../../ports/foundation";
import { err, ok, tryCatch, type Result } from "../../try-catch";
import { applyIntegrationEventWithRetry } from "./integration-event-retry";
import { reconcileCompositeReadiness } from "./readiness";

const LIVEKIT_WEBHOOK_CONTENT_TYPE = "application/webhook+json";
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_LENGTH = 4096;
const ARTIFACT_UPLOAD_WINDOW_MS = 2 * 60_000;
const LIVEKIT_EVENT_ID_PATTERN = /^EV_[A-Za-z0-9]{12}$/;
const CONVERSATION_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const LIVEKIT_ROOM_PATTERN = new RegExp(`^conversation-(${CONVERSATION_ID_PATTERN})$`);

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
  const event = received.value;

  const validEvent = validateWebhookEvent(event);
  if (!validEvent.ok) return validEvent;
  const correlatedConversation = conversationIdFromEvent(event);
  if (!correlatedConversation.ok) return correlatedConversation;
  const conversationId = correlatedConversation.value;
  const stub = dependencies.conversations.get(conversationId);
  const initial = await tryCatch(
    async (): Promise<ConversationState | null> => await stub.getState(),
    webhookOperationFailed,
  );
  if (!initial.ok) return initial;
  if (initial.value === null) {
    return err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  const correlatedEgress = await validateEgressCorrelation(event, stub);
  if (!correlatedEgress.ok) return correlatedEgress;

  const result = await translateWebhookEvent(
    event,
    conversationId,
    initial.value,
    stub,
    dependencies,
  );
  if (!result.ok) return result;
  console.log(
    JSON.stringify({
      kind: "livekit_webhook_processed",
      eventId: event.id,
      eventType: event.event,
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

function validateWebhookEvent(event: WebhookEvent): Result<void, ApiError> {
  if (!LIVEKIT_EVENT_ID_PATTERN.test(event.id)) {
    return err(new ApiError(400, "invalid_livekit_event", "The LiveKit event ID is invalid."));
  }
  if (event.event.length === 0) {
    return err(new ApiError(400, "invalid_livekit_event", "The LiveKit event type is missing."));
  }
  return ok(undefined);
}

function conversationIdFromEvent(event: WebhookEvent): Result<string, ApiError> {
  const roomName = event.egressInfo?.roomName || event.room?.name;
  if (roomName === undefined || roomName.length === 0) {
    return err(new ApiError(400, "livekit_room_missing", "The LiveKit room is missing."));
  }
  if (
    event.egressInfo?.roomName !== undefined &&
    event.room?.name !== undefined &&
    event.egressInfo.roomName !== event.room.name
  ) {
    return err(new ApiError(400, "livekit_room_mismatch", "The LiveKit room does not match."));
  }
  const match = LIVEKIT_ROOM_PATTERN.exec(roomName);
  const conversationId = match?.[1];
  if (conversationId === undefined) {
    return err(new ApiError(400, "invalid_livekit_room", "The LiveKit room name is invalid."));
  }
  return ok(conversationId);
}

async function translateWebhookEvent(
  event: WebhookEvent,
  conversationId: string,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  dependencies: LiveKitWebhookDependencies,
): Promise<Result<TranslatedWebhookResult, ApiError>> {
  const eventType: string = event.event;
  switch (eventType) {
    case "egress_started":
    case "egress_updated":
      return handleEgressProgress(event, state, stub, dependencies);
    case "egress_ended":
      return handleEgressEnded(event, conversationId, state, stub, dependencies);
    case "room_finished":
      return handleRoomFinished(event, state, stub, dependencies);
    case "room_started":
    case "participant_joined":
    case "participant_left":
    case "participant_connection_aborted":
    case "track_published":
    case "track_unpublished":
      return handleMediaObservation(event, conversationId, state, stub, dependencies);
    case "ingress_started":
    case "ingress_ended":
      return ok({ state, outcome: "observation_acknowledged" });
    case "":
      return err(new ApiError(400, "invalid_livekit_event", "The LiveKit event type is missing."));
    default:
      return err(
        new ApiError(400, "unsupported_livekit_event", "The LiveKit event type is unsupported."),
      );
  }
}

async function handleEgressProgress(
  event: WebhookEvent,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  dependencies: Pick<LiveKitWebhookDependencies, "clock">,
): Promise<Result<TranslatedWebhookResult, ApiError>> {
  const requiredEgress = requireEgressInfo(event);
  if (!requiredEgress.ok) return requiredEgress;
  const egress = requiredEgress.value;
  if (isFailedEgressStatus(egress.status)) {
    return failArtifact(event, state, stub, egressFailureCode(egress.status), dependencies.clock);
  }
  if (egress.status !== EgressStatus.EGRESS_ACTIVE) {
    return ok({ state, outcome: "egress_observation_acknowledged" });
  }
  if (state.data.artifact.status !== ArtifactStatus.Pending) {
    return ok({ state, outcome: "recording_already_observed" });
  }
  if (state.tag !== ConversationStateTag.Starting) {
    return err(
      new ApiError(409, "conversation_not_ready", "Conversation is not ready for recording."),
    );
  }
  const recordingId = requireEgressId(egress.egressId);
  if (!recordingId.ok) return recordingId;
  const observedAt = dependencies.clock.now();
  const applied = await applyIntegrationEvent(stub, state, {
    type: ConversationEventType.RecordingStarted,
    eventId: domainEventId(event, "recording-started"),
    at: value.unixMillis(observedAt),
    recordingId: value.recordingId(recordingId.value),
  });
  if (!applied.ok) return applied;
  const reconciled = await reconcileCompositeReadiness(stub, observedAt);
  if (!reconciled.ok) return reconciled;
  return ok({ state: reconciled.value, outcome: "recording_started" });
}

async function handleMediaObservation(
  event: WebhookEvent,
  conversationId: string,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  dependencies: Pick<LiveKitWebhookDependencies, "clock">,
): Promise<Result<TranslatedWebhookResult, ApiError>> {
  const evidence = await tryCatch(() => stub.getLiveKitTransportEvidence(), webhookOperationFailed);
  if (!evidence.ok) return evidence;
  const observationKind = mediaObservationKind(
    event,
    conversationId,
    evidence.value?.agentParticipantIdentity ?? null,
  );
  if (!observationKind.ok) return observationKind;
  const kind = observationKind.value;
  if (kind === null) return ok({ state, outcome: "observation_acknowledged" });
  const transport = state.data.transport;
  if (transport.status === TransportStatus.Idle) {
    return ok({ state, outcome: "observation_before_start" });
  }
  const participantIdentity = requireParticipantIdentity(event);
  if (!participantIdentity.ok) return participantIdentity;
  const roomName = requireRoomName(event);
  if (!roomName.ok) return roomName;
  const recorded = await tryCatch(
    () =>
      stub.recordLiveKitMediaObservation({
        eventId: event.id,
        kind,
        participantIdentity: participantIdentity.value,
        roomName: roomName.value,
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
      eventId: domainEventId(event, "transport-interrupted"),
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

function mediaObservationKind(
  event: WebhookEvent,
  conversationId: string,
  knownAgentIdentity: string | null,
): Result<LiveKitMediaObservationKind | null, ApiError> {
  const participant = event.participant;
  if (participant === undefined) {
    return err(
      new ApiError(400, "livekit_participant_missing", "The LiveKit participant is missing."),
    );
  }
  const isBrowser = participant.identity === `browser-${conversationId}`;
  const isAgent =
    participant.kind === ParticipantInfo_Kind.AGENT || participant.identity === knownAgentIdentity;
  if (!isBrowser && !isAgent) return ok(null);

  switch (event.event) {
    case "participant_joined":
      return ok(isBrowser ? "browser_participant_joined" : "agent_participant_joined");
    case "participant_left":
    case "participant_connection_aborted":
      return ok(isBrowser ? "browser_participant_left" : "agent_participant_left");
    case "track_published":
    case "track_unpublished": {
      const track = event.track;
      if (
        track === undefined ||
        track.type !== TrackType.AUDIO ||
        track.source !== TrackSource.MICROPHONE
      ) {
        return ok(null);
      }
      const published = event.event === "track_published";
      if (isBrowser) {
        return ok(published ? "browser_audio_published" : "browser_audio_unpublished");
      }
      return ok(published ? "agent_audio_published" : "agent_audio_unpublished");
    }
    default:
      return ok(null);
  }
}

function requireParticipantIdentity(event: WebhookEvent): Result<string, ApiError> {
  const identity = event.participant?.identity;
  if (identity === undefined || identity.length === 0) {
    return err(
      new ApiError(
        400,
        "livekit_participant_identity_missing",
        "The LiveKit participant identity is missing.",
      ),
    );
  }
  return ok(identity);
}

function isNegativeMediaObservation(kind: LiveKitMediaObservationKind): boolean {
  return kind.endsWith("_left") || kind.endsWith("_unpublished");
}

function requireRoomName(event: WebhookEvent): Result<string, ApiError> {
  const roomName = event.room?.name;
  if (roomName === undefined || roomName.length === 0) {
    return err(new ApiError(400, "livekit_room_missing", "The LiveKit room is missing."));
  }
  return ok(roomName);
}

async function handleEgressEnded(
  event: WebhookEvent,
  conversationId: string,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  dependencies: Pick<LiveKitWebhookDependencies, "clock" | "recordings">,
): Promise<Result<TranslatedWebhookResult, ApiError>> {
  const requiredEgress = requireEgressInfo(event);
  if (!requiredEgress.ok) return requiredEgress;
  const egress = requiredEgress.value;
  if (isFailedEgressStatus(egress.status)) {
    return failArtifact(event, state, stub, egressFailureCode(egress.status), dependencies.clock);
  }
  if (egress.status !== EgressStatus.EGRESS_COMPLETE) {
    return failArtifact(
      event,
      state,
      stub,
      "artifact.livekit_egress_incomplete",
      dependencies.clock,
    );
  }

  const recordingId = requireEgressId(egress.egressId);
  if (!recordingId.ok) return recordingId;
  const objectKey = recordingObjectKey(event, conversationId);
  if (!objectKey.ok) {
    return objectKey.error.code === "invalid_livekit_output"
      ? failArtifact(event, state, stub, "artifact.livekit_output_invalid", dependencies.clock)
      : objectKey;
  }
  const r2Key = objectKey.value;
  let current = state;
  const provisioning = await tryCatch(() => stub.getLiveKitProvisioning(), webhookOperationFailed);
  if (!provisioning.ok) return provisioning;
  if (provisioning.value === null || provisioning.value.expectedR2Key !== r2Key) {
    return failArtifact(
      event,
      current,
      stub,
      "artifact.livekit_output_mismatch",
      dependencies.clock,
    );
  }

  if (current.data.artifact.status === ArtifactStatus.Pending) {
    return failArtifact(
      event,
      current,
      stub,
      "artifact.livekit_recording_not_observed",
      dependencies.clock,
    );
  }

  if (current.data.artifact.status === ArtifactStatus.Recording) {
    if (current.tag !== ConversationStateTag.Ending) {
      return failArtifact(
        event,
        current,
        stub,
        "artifact.livekit_egress_ended_early",
        dependencies.clock,
      );
    }
    const uploadStartedAt = dependencies.clock.now();
    const applied = await applyIntegrationEvent(stub, current, {
      type: ConversationEventType.RecordingUploadStarted,
      eventId: domainEventId(event, "recording-upload-started"),
      at: value.unixMillis(uploadStartedAt),
      recordingId: value.recordingId(recordingId.value),
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
    current.data.artifact.recordingId !== recordingId.value ||
    current.data.artifact.expectedR2Key !== r2Key
  ) {
    return failArtifact(
      event,
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
    eventId: domainEventId(event, "recording-artifact-verified"),
    at: value.unixMillis(dependencies.clock.now()),
    recordingId: value.recordingId(recordingId.value),
    r2Key: value.r2ObjectKey(r2Key),
    r2Etag: value.r2Etag(object.value.etag),
  });
  if (!verified.ok) return verified;
  return ok({ state: verified.value, outcome: "recording_artifact_verified" });
}

async function validateEgressCorrelation(
  event: WebhookEvent,
  stub: DurableObjectStub<ConversationSession>,
): Promise<Result<void, ApiError>> {
  const egress = event.egressInfo;
  if (egress === undefined) return ok(undefined);
  const provisioning = await tryCatch(() => stub.getLiveKitProvisioning(), webhookOperationFailed);
  if (!provisioning.ok) return provisioning;
  if (provisioning.value === null || provisioning.value.egressId !== egress.egressId) {
    return err(
      new ApiError(409, "livekit_egress_mismatch", "The LiveKit egress does not correlate."),
    );
  }
  return ok(undefined);
}

async function handleRoomFinished(
  event: WebhookEvent,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  dependencies: Pick<LiveKitWebhookDependencies, "clock">,
): Promise<Result<TranslatedWebhookResult, ApiError>> {
  const transport = state.data.transport;
  if (transport.status === TransportStatus.Closed || transport.status === TransportStatus.Failed) {
    return ok({ state, outcome: "transport_already_terminal" });
  }
  if (transport.status === TransportStatus.Idle) {
    return ok({ state, outcome: "room_finished_before_start" });
  }
  const next = await applyIntegrationEvent(stub, state, {
    type: ConversationEventType.SessionClosed,
    eventId: domainEventId(event, "session-closed"),
    at: value.unixMillis(dependencies.clock.now()),
    epoch: transport.epoch,
  });
  if (!next.ok) return next;
  return ok({ state: next.value, outcome: "session_closed" });
}

async function failArtifact(
  event: WebhookEvent,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  errorCode: string,
  clock: LiveKitWebhookDependencies["clock"],
): Promise<Result<TranslatedWebhookResult, ApiError>> {
  if (
    (state.tag === ConversationStateTag.Ending && state.data.target.kind === "cancel") ||
    state.data.artifact.status === ArtifactStatus.Failed ||
    state.data.artifact.status === ArtifactStatus.Ready ||
    state.tag === ConversationStateTag.Completed ||
    state.tag === ConversationStateTag.Cancelled ||
    state.tag === ConversationStateTag.Failed
  ) {
    return ok({ state, outcome: "artifact_terminal" });
  }
  const recordingId = event.egressInfo?.egressId || null;
  const observedAt = clock.now();
  const next = await applyIntegrationEvent(stub, state, {
    type: ConversationEventType.ArtifactFailed,
    eventId: domainEventId(event, "artifact-failed"),
    at: value.unixMillis(observedAt),
    recordingId: recordingId === null ? null : value.recordingId(recordingId),
    errorCode: value.errorCode(errorCode),
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

function requireEgressInfo(
  event: WebhookEvent,
): Result<NonNullable<WebhookEvent["egressInfo"]>, ApiError> {
  if (event.egressInfo === undefined) {
    return err(
      new ApiError(400, "livekit_egress_missing", "The LiveKit egress payload is missing."),
    );
  }
  return ok(event.egressInfo);
}

function requireEgressId(egressId: string): Result<string, ApiError> {
  if (egressId.length === 0 || egressId.length > 256) {
    return err(new ApiError(400, "invalid_livekit_egress", "The LiveKit egress ID is invalid."));
  }
  return ok(egressId);
}

function recordingObjectKey(event: WebhookEvent, conversationId: string): Result<string, ApiError> {
  const egress = requireEgressInfo(event);
  if (!egress.ok) return egress;
  const fileResults = egress.value.fileResults.filter((result) => result.filename.length > 0);
  if (fileResults.length !== 1) {
    return err(
      new ApiError(400, "invalid_livekit_output", "Expected one LiveKit recording output."),
    );
  }
  const key = fileResults[0]?.filename;
  const prefix = `conversations/${conversationId}/`;
  if (
    key === undefined ||
    key.length > 1024 ||
    !key.startsWith(prefix) ||
    key.includes("..") ||
    key.endsWith("/")
  ) {
    return err(new ApiError(400, "invalid_livekit_output", "The recording object key is invalid."));
  }
  return ok(key);
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

function domainEventId(event: WebhookEvent, suffix: string): string {
  return `livekit:webhook:${event.id}:${suffix}`;
}

function isFailedEgressStatus(status: EgressStatus): boolean {
  return (
    status === EgressStatus.EGRESS_FAILED ||
    status === EgressStatus.EGRESS_ABORTED ||
    status === EgressStatus.EGRESS_LIMIT_REACHED
  );
}

function egressFailureCode(status: EgressStatus): string {
  switch (status) {
    case EgressStatus.EGRESS_ABORTED:
      return "artifact.livekit_egress_aborted";
    case EgressStatus.EGRESS_LIMIT_REACHED:
      return "artifact.livekit_egress_limit_reached";
    case EgressStatus.EGRESS_FAILED:
    default:
      return "artifact.livekit_egress_failed";
  }
}
