/**
 * LiveKit-to-control-plane integration boundary.
 *
 * LiveKit SDK payloads terminate here: signatures and correlation fields are validated, provider
 * observations are translated to provider-neutral domain events, and completed R2 objects are
 * verified before the Durable Object can mark an artifact ready.
 */
import { ParticipantInfo_Kind, TrackSource, TrackType } from "@livekit/protocol";
import { EgressStatus, WebhookReceiver, type WebhookEvent } from "livekit-server-sdk";

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
import { applyIntegrationEventWithRetry } from "./integration-event-retry";
import { reconcileCompositeReadiness } from "./readiness";

const LIVEKIT_WEBHOOK_CONTENT_TYPE = "application/webhook+json";
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_LENGTH = 4096;
const ARTIFACT_UPLOAD_WINDOW_MS = 2 * 60_000;
const LIVEKIT_EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONVERSATION_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const LIVEKIT_ROOM_PATTERN = new RegExp(`^conversation-(${CONVERSATION_ID_PATTERN})$`);

export const LIVEKIT_ROOM_PREFIX = "conversation-";

export interface LiveKitWebhookResult {
  readonly conversationId: string;
  readonly state: ConversationState;
  readonly outcome: string;
}

export async function handleLiveKitWebhook(
  request: Request,
  env: Env,
): Promise<LiveKitWebhookResult> {
  assertWebhookRequest(request);
  assertWebhookConfiguration(env);

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new ApiError(413, "livekit_webhook_too_large", "The webhook body is too large.");
  }

  const received = await receiveSignedWebhook(
    new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET),
    body,
    request.headers.get("Authorization") ?? undefined,
  );
  if (!received.success) {
    throw new ApiError(
      401,
      "invalid_livekit_webhook",
      "The LiveKit webhook signature is invalid.",
      {},
      received.error,
    );
  }
  const event = received.event;

  validateWebhookEvent(event);
  const conversationId = conversationIdFromEvent(event);
  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  const initial = await stub.getState();
  if (initial === null) {
    throw new ApiError(404, "conversation_not_found", "Conversation not found.");
  }
  await validateEgressCorrelation(event, stub);

  const result = await translateWebhookEvent(event, conversationId, initial, stub, env);
  console.log(
    JSON.stringify({
      kind: "livekit_webhook_processed",
      eventId: event.id,
      eventType: event.event,
      conversationId,
      outcome: result.outcome,
      resultingState: result.state.tag,
      resultingRevision: result.state.revision,
    }),
  );
  return { conversationId, ...result };
}

async function receiveSignedWebhook(
  receiver: WebhookReceiver,
  body: string,
  authorization: string | undefined,
): Promise<
  Readonly<{ success: true; event: WebhookEvent }> | Readonly<{ success: false; error: unknown }>
> {
  try {
    return { success: true, event: await receiver.receive(body, authorization) };
  } catch (error) {
    return { success: false, error };
  }
}

function assertWebhookRequest(request: Request): void {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== LIVEKIT_WEBHOOK_CONTENT_TYPE) {
    throw new ApiError(
      415,
      "unsupported_media_type",
      `Content-Type must be ${LIVEKIT_WEBHOOK_CONTENT_TYPE}.`,
    );
  }
  const authorization = request.headers.get("Authorization");
  if (authorization === null || authorization.length === 0) {
    throw new ApiError(401, "invalid_livekit_webhook", "The LiveKit signature is required.");
  }
  if (authorization.length > MAX_AUTHORIZATION_LENGTH) {
    throw new ApiError(431, "request_header_too_large", "A request header is too large.");
  }
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ApiError(400, "invalid_content_length", "Content-Length is invalid.");
    }
    if (length > MAX_WEBHOOK_BODY_BYTES) {
      throw new ApiError(413, "livekit_webhook_too_large", "The webhook body is too large.");
    }
  }
}

function assertWebhookConfiguration(env: Env): void {
  if (env.LIVEKIT_API_KEY.length === 0 || env.LIVEKIT_API_SECRET.length === 0) {
    throw new Error("LiveKit webhook credentials are not configured");
  }
}

function validateWebhookEvent(event: WebhookEvent): void {
  if (!LIVEKIT_EVENT_ID_PATTERN.test(event.id)) {
    throw new ApiError(400, "invalid_livekit_event", "The LiveKit event ID is invalid.");
  }
  if (event.event.length === 0) {
    throw new ApiError(400, "invalid_livekit_event", "The LiveKit event type is missing.");
  }
}

function conversationIdFromEvent(event: WebhookEvent): string {
  const roomName = event.egressInfo?.roomName || event.room?.name;
  if (roomName === undefined || roomName.length === 0) {
    throw new ApiError(400, "livekit_room_missing", "The LiveKit room is missing.");
  }
  if (
    event.egressInfo?.roomName !== undefined &&
    event.room?.name !== undefined &&
    event.egressInfo.roomName !== event.room.name
  ) {
    throw new ApiError(400, "livekit_room_mismatch", "The LiveKit room does not match.");
  }
  const match = LIVEKIT_ROOM_PATTERN.exec(roomName);
  const conversationId = match?.[1];
  if (conversationId === undefined) {
    throw new ApiError(400, "invalid_livekit_room", "The LiveKit room name is invalid.");
  }
  return conversationId;
}

async function translateWebhookEvent(
  event: WebhookEvent,
  conversationId: string,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  env: Env,
): Promise<{ readonly state: ConversationState; readonly outcome: string }> {
  const eventType: string = event.event;
  switch (eventType) {
    case "egress_started":
    case "egress_updated":
      return handleEgressProgress(event, state, stub);
    case "egress_ended":
      return handleEgressEnded(event, conversationId, state, stub, env);
    case "room_finished":
      return handleRoomFinished(event, state, stub);
    case "room_started":
    case "participant_joined":
    case "participant_left":
    case "participant_connection_aborted":
    case "track_published":
    case "track_unpublished":
      return handleMediaObservation(event, conversationId, state, stub);
    case "ingress_started":
    case "ingress_ended":
      return { state, outcome: "observation_acknowledged" };
    case "":
      throw new ApiError(400, "invalid_livekit_event", "The LiveKit event type is missing.");
    default:
      throw new ApiError(
        400,
        "unsupported_livekit_event",
        "The LiveKit event type is unsupported.",
      );
  }
}

async function handleEgressProgress(
  event: WebhookEvent,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
): Promise<{ readonly state: ConversationState; readonly outcome: string }> {
  const egress = requireEgressInfo(event);
  if (isFailedEgressStatus(egress.status)) {
    return failArtifact(event, state, stub, egressFailureCode(egress.status));
  }
  if (egress.status !== EgressStatus.EGRESS_ACTIVE) {
    return { state, outcome: "egress_observation_acknowledged" };
  }
  if (state.data.artifact.status !== ArtifactStatus.Pending) {
    return { state, outcome: "recording_already_observed" };
  }
  if (state.tag !== ConversationStateTag.Starting) {
    throw new ApiError(409, "conversation_not_ready", "Conversation is not ready for recording.");
  }
  const recordingId = requireEgressId(egress.egressId);
  await applyIntegrationEvent(stub, state, {
    type: ConversationEventType.RecordingStarted,
    eventId: domainEventId(event, "recording-started"),
    at: value.unixMillis(Date.now()),
    recordingId: value.recordingId(recordingId),
  });
  const reconciled = await reconcileCompositeReadiness(stub, Date.now());
  if (!reconciled.ok) throw reconciled.error;
  return { state: reconciled.value, outcome: "recording_started" };
}

async function handleMediaObservation(
  event: WebhookEvent,
  conversationId: string,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
): Promise<{ readonly state: ConversationState; readonly outcome: string }> {
  const evidence = await stub.getLiveKitTransportEvidence();
  const kind = mediaObservationKind(
    event,
    conversationId,
    evidence?.agentParticipantIdentity ?? null,
  );
  if (kind === null) return { state, outcome: "observation_acknowledged" };
  const transport = state.data.transport;
  if (transport.status === TransportStatus.Idle) {
    return { state, outcome: "observation_before_start" };
  }
  const recorded = await stub.recordLiveKitMediaObservation({
    eventId: event.id,
    kind,
    participantIdentity: requireParticipantIdentity(event),
    roomName: requireRoomName(event),
    transportEpoch: transport.epoch,
  });
  if (recorded === "rejected") return { state, outcome: "observation_uncorrelated" };

  if (
    isNegativeMediaObservation(kind) &&
    state.tag === ConversationStateTag.Live &&
    state.data.transport.status === TransportStatus.Connected
  ) {
    const at = Date.now();
    const interrupted = await applyIntegrationEvent(stub, state, {
      type: ConversationEventType.TransportInterrupted,
      eventId: domainEventId(event, "transport-interrupted"),
      at: value.unixMillis(at),
      epoch: transport.epoch,
      errorCode: value.errorCode("transport.livekit_media_interrupted"),
      recoveryDeadlineAt: value.unixMillis(at + TRANSPORT_RECOVERY_WINDOW_MS),
    });
    return { state: interrupted, outcome: "transport_interrupted" };
  }

  const reconciled = await reconcileCompositeReadiness(stub, Date.now());
  if (!reconciled.ok) throw reconciled.error;
  return {
    state: reconciled.value,
    outcome: recorded === "duplicate" ? "observation_duplicate" : "readiness_reconciled",
  };
}

function mediaObservationKind(
  event: WebhookEvent,
  conversationId: string,
  knownAgentIdentity: string | null,
): LiveKitMediaObservationKind | null {
  const participant = event.participant;
  if (participant === undefined) {
    throw new ApiError(400, "livekit_participant_missing", "The LiveKit participant is missing.");
  }
  const isBrowser = participant.identity === `browser-${conversationId}`;
  const isAgent =
    participant.kind === ParticipantInfo_Kind.AGENT || participant.identity === knownAgentIdentity;
  if (!isBrowser && !isAgent) return null;

  switch (event.event) {
    case "participant_joined":
      return isBrowser ? "browser_participant_joined" : "agent_participant_joined";
    case "participant_left":
    case "participant_connection_aborted":
      return isBrowser ? "browser_participant_left" : "agent_participant_left";
    case "track_published":
    case "track_unpublished": {
      const track = event.track;
      if (
        track === undefined ||
        track.type !== TrackType.AUDIO ||
        track.source !== TrackSource.MICROPHONE
      ) {
        return null;
      }
      const published = event.event === "track_published";
      if (isBrowser) return published ? "browser_audio_published" : "browser_audio_unpublished";
      return published ? "agent_audio_published" : "agent_audio_unpublished";
    }
    default:
      return null;
  }
}

function requireParticipantIdentity(event: WebhookEvent): string {
  const identity = event.participant?.identity;
  if (identity === undefined || identity.length === 0) {
    throw new ApiError(
      400,
      "livekit_participant_identity_missing",
      "The LiveKit participant identity is missing.",
    );
  }
  return identity;
}

function isNegativeMediaObservation(kind: LiveKitMediaObservationKind): boolean {
  return kind.endsWith("_left") || kind.endsWith("_unpublished");
}

function requireRoomName(event: WebhookEvent): string {
  const roomName = event.room?.name;
  if (roomName === undefined || roomName.length === 0) {
    throw new ApiError(400, "livekit_room_missing", "The LiveKit room is missing.");
  }
  return roomName;
}

async function handleEgressEnded(
  event: WebhookEvent,
  conversationId: string,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  env: Env,
): Promise<{ readonly state: ConversationState; readonly outcome: string }> {
  const egress = requireEgressInfo(event);
  if (isFailedEgressStatus(egress.status)) {
    return failArtifact(event, state, stub, egressFailureCode(egress.status));
  }
  if (egress.status !== EgressStatus.EGRESS_COMPLETE) {
    return failArtifact(event, state, stub, "artifact.livekit_egress_incomplete");
  }

  const recordingId = requireEgressId(egress.egressId);
  let r2Key: string;
  try {
    r2Key = recordingObjectKey(event, conversationId);
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_livekit_output") {
      return failArtifact(event, state, stub, "artifact.livekit_output_invalid");
    }
    throw error;
  }
  let current = state;
  const provisioning = await stub.getLiveKitProvisioning();
  if (provisioning === null || provisioning.expectedR2Key !== r2Key) {
    return failArtifact(event, current, stub, "artifact.livekit_output_mismatch");
  }

  if (current.data.artifact.status === ArtifactStatus.Pending) {
    return failArtifact(event, current, stub, "artifact.livekit_recording_not_observed");
  }

  if (current.data.artifact.status === ArtifactStatus.Recording) {
    if (current.tag !== ConversationStateTag.Ending) {
      return failArtifact(event, current, stub, "artifact.livekit_egress_ended_early");
    }
    current = await applyIntegrationEvent(stub, current, {
      type: ConversationEventType.RecordingUploadStarted,
      eventId: domainEventId(event, "recording-upload-started"),
      at: value.unixMillis(Date.now()),
      recordingId: value.recordingId(recordingId),
      expectedR2Key: value.r2ObjectKey(r2Key),
      artifactDeadlineAt: value.unixMillis(Date.now() + ARTIFACT_UPLOAD_WINDOW_MS),
    });
  }

  if (current.data.artifact.status === ArtifactStatus.Ready) {
    return { state: current, outcome: "artifact_already_ready" };
  }
  if (current.data.artifact.status !== ArtifactStatus.Uploading) {
    return { state: current, outcome: "artifact_not_required" };
  }
  if (
    current.data.artifact.recordingId !== recordingId ||
    current.data.artifact.expectedR2Key !== r2Key
  ) {
    return failArtifact(event, current, stub, "artifact.livekit_output_mismatch");
  }

  const object = await env.RECORDINGS.head(r2Key);
  if (object === null || object.size === 0) {
    throw new ApiError(
      503,
      "recording_not_available",
      "The recording is not yet available in object storage.",
      { "Retry-After": "2" },
    );
  }

  const verified = await applyIntegrationEvent(stub, current, {
    type: ConversationEventType.RecordingArtifactVerified,
    eventId: domainEventId(event, "recording-artifact-verified"),
    at: value.unixMillis(Date.now()),
    recordingId: value.recordingId(recordingId),
    r2Key: value.r2ObjectKey(r2Key),
    r2Etag: value.r2Etag(object.etag),
  });
  return { state: verified, outcome: "recording_artifact_verified" };
}

async function validateEgressCorrelation(
  event: WebhookEvent,
  stub: DurableObjectStub<ConversationSession>,
): Promise<void> {
  const egress = event.egressInfo;
  if (egress === undefined) return;
  const provisioning = await stub.getLiveKitProvisioning();
  if (provisioning === null || provisioning.egressId !== egress.egressId) {
    throw new ApiError(409, "livekit_egress_mismatch", "The LiveKit egress does not correlate.");
  }
}

async function handleRoomFinished(
  event: WebhookEvent,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
): Promise<{ readonly state: ConversationState; readonly outcome: string }> {
  const transport = state.data.transport;
  if (transport.status === TransportStatus.Closed || transport.status === TransportStatus.Failed) {
    return { state, outcome: "transport_already_terminal" };
  }
  if (transport.status === TransportStatus.Idle) {
    return { state, outcome: "room_finished_before_start" };
  }
  const next = await applyIntegrationEvent(stub, state, {
    type: ConversationEventType.SessionClosed,
    eventId: domainEventId(event, "session-closed"),
    at: value.unixMillis(Date.now()),
    epoch: transport.epoch,
  });
  return { state: next, outcome: "session_closed" };
}

async function failArtifact(
  event: WebhookEvent,
  state: ConversationState,
  stub: DurableObjectStub<ConversationSession>,
  errorCode: string,
): Promise<{ readonly state: ConversationState; readonly outcome: string }> {
  if (
    (state.tag === ConversationStateTag.Ending && state.data.target.kind === "cancel") ||
    state.data.artifact.status === ArtifactStatus.Failed ||
    state.data.artifact.status === ArtifactStatus.Ready ||
    state.tag === ConversationStateTag.Completed ||
    state.tag === ConversationStateTag.Cancelled ||
    state.tag === ConversationStateTag.Failed
  ) {
    return { state, outcome: "artifact_terminal" };
  }
  const recordingId = event.egressInfo?.egressId || null;
  const next = await applyIntegrationEvent(stub, state, {
    type: ConversationEventType.ArtifactFailed,
    eventId: domainEventId(event, "artifact-failed"),
    at: value.unixMillis(Date.now()),
    recordingId: recordingId === null ? null : value.recordingId(recordingId),
    errorCode: value.errorCode(errorCode),
    endingDeadlineAt: value.unixMillis(Date.now() + ALARM_SHUTDOWN_GRACE_MS),
  });
  return { state: next, outcome: "artifact_failed" };
}

async function applyIntegrationEvent(
  stub: DurableObjectStub<ConversationSession>,
  initial: ConversationState,
  event: ConversationEvent,
): Promise<ConversationState> {
  const applied = await applyIntegrationEventWithRetry(stub, initial, event, {
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
  if (!applied.ok) throw applied.error;
  return applied.value;
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

function requireEgressInfo(event: WebhookEvent): NonNullable<WebhookEvent["egressInfo"]> {
  if (event.egressInfo === undefined) {
    throw new ApiError(400, "livekit_egress_missing", "The LiveKit egress payload is missing.");
  }
  return event.egressInfo;
}

function requireEgressId(egressId: string): string {
  if (egressId.length === 0 || egressId.length > 256) {
    throw new ApiError(400, "invalid_livekit_egress", "The LiveKit egress ID is invalid.");
  }
  return egressId;
}

function recordingObjectKey(event: WebhookEvent, conversationId: string): string {
  const fileResults = requireEgressInfo(event).fileResults.filter(
    (result) => result.filename.length > 0,
  );
  if (fileResults.length !== 1) {
    throw new ApiError(400, "invalid_livekit_output", "Expected one LiveKit recording output.");
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
    throw new ApiError(400, "invalid_livekit_output", "The recording object key is invalid.");
  }
  return key;
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
