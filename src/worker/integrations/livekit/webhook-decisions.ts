/** Pure LiveKit webhook decoding and state-dependent interpretation. */
import { ParticipantInfo_Kind, TrackSource, TrackType } from "@livekit/protocol";
import { EgressStatus, type WebhookEvent } from "livekit-server-sdk";

import {
  ArtifactStatus,
  ConversationStateTag,
  TransportStatus,
  type ConversationState,
} from "../../../domain/conversation-state-machine";
import type { LiveKitMediaObservationKind } from "../../../durable-object/conversation-session";
import { err, ok, type Result } from "@ai-oral-exam/result";

const LIVEKIT_EVENT_ID_PATTERN = /^EV_[A-Za-z0-9]{12}$/;
const CONVERSATION_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const LIVEKIT_ROOM_PATTERN = new RegExp(`^conversation-(${CONVERSATION_ID_PATTERN})$`);

export type LiveKitEgressStatus =
  | "starting"
  | "active"
  | "ending"
  | "complete"
  | "failed"
  | "aborted"
  | "limit_reached"
  | "other";

interface DecodedWebhookBase {
  readonly eventId: string;
  readonly eventType: string;
  readonly conversationId: string;
  readonly roomName: string;
}

export interface DecodedEgressWebhook extends DecodedWebhookBase {
  readonly kind: "egress_progress" | "egress_ended";
  readonly egressId: string;
  readonly status: LiveKitEgressStatus;
  readonly outputFilenames: readonly string[];
}

export interface DecodedMediaWebhook extends DecodedWebhookBase {
  readonly kind: "media";
  readonly participantIdentity: string;
  readonly participantIsAgent: boolean;
  readonly microphoneAudio: boolean;
}

export type DecodedLiveKitWebhook =
  | DecodedEgressWebhook
  | DecodedMediaWebhook
  | (DecodedWebhookBase & Readonly<{ kind: "room_finished" }>)
  | (DecodedWebhookBase & Readonly<{ kind: "acknowledged" }>);

export type LiveKitWebhookDecodeError =
  | "invalid_event"
  | "event_type_missing"
  | "room_missing"
  | "room_mismatch"
  | "invalid_room"
  | "egress_missing"
  | "participant_missing"
  | "participant_identity_missing"
  | "unsupported_event";

export type LiveKitWebhookDecisionError =
  | "conversation_not_ready"
  | "invalid_egress"
  | "invalid_output_count"
  | "invalid_output_key";

export type EgressProgressDecision =
  | Readonly<{ kind: "acknowledge"; outcome: string }>
  | Readonly<{ kind: "fail_artifact"; errorCode: string }>
  | Readonly<{ kind: "recording_started"; recordingId: string }>;

export type ArtifactFailureDecision =
  | Readonly<{ kind: "acknowledge"; outcome: "artifact_terminal" }>
  | Readonly<{ kind: "apply"; recordingId: string | null; errorCode: string }>;

export type RoomFinishedDecision =
  | Readonly<{
      kind: "acknowledge";
      outcome: "transport_already_terminal" | "room_finished_before_start";
    }>
  | Readonly<{ kind: "close_session"; epoch: number }>;

export interface CompletedEgressRecording {
  readonly recordingId: string;
  readonly r2Key: string;
}

export function decodeLiveKitWebhook(
  event: WebhookEvent,
): Result<DecodedLiveKitWebhook, LiveKitWebhookDecodeError> {
  if (!LIVEKIT_EVENT_ID_PATTERN.test(event.id)) return err("invalid_event");
  if (event.event.length === 0) return err("event_type_missing");

  const egressRoomName = event.egressInfo?.roomName;
  const eventRoomName = event.room?.name;
  const roomName = egressRoomName || eventRoomName;
  if (roomName === undefined || roomName.length === 0) return err("room_missing");
  if (
    egressRoomName !== undefined &&
    eventRoomName !== undefined &&
    egressRoomName !== eventRoomName
  ) {
    return err("room_mismatch");
  }
  const conversationId = LIVEKIT_ROOM_PATTERN.exec(roomName)?.[1];
  if (conversationId === undefined) return err("invalid_room");

  const base = { eventId: event.id, eventType: event.event, conversationId, roomName };
  switch (event.event) {
    case "egress_started":
    case "egress_updated":
    case "egress_ended": {
      const egress = event.egressInfo;
      if (egress === undefined) return err("egress_missing");
      return ok({
        ...base,
        kind: event.event === "egress_ended" ? "egress_ended" : "egress_progress",
        egressId: egress.egressId,
        status: decodeEgressStatus(egress.status),
        outputFilenames: egress.fileResults.map((result) => result.filename),
      });
    }
    case "room_finished":
      return ok({ ...base, kind: "room_finished" });
    case "room_started":
    case "participant_joined":
    case "participant_left":
    case "participant_connection_aborted":
    case "track_published":
    case "track_unpublished": {
      const participant = event.participant;
      if (participant === undefined) return err("participant_missing");
      if (participant.identity.length === 0) return err("participant_identity_missing");
      return ok({
        ...base,
        kind: "media",
        participantIdentity: participant.identity,
        participantIsAgent: participant.kind === ParticipantInfo_Kind.AGENT,
        microphoneAudio:
          event.track?.type === TrackType.AUDIO && event.track.source === TrackSource.MICROPHONE,
      });
    }
    case "ingress_started":
    case "ingress_ended":
      return ok({ ...base, kind: "acknowledged" });
    default:
      return err("unsupported_event");
  }
}

export function decideEgressProgress(
  observation: DecodedEgressWebhook,
  state: ConversationState,
): Result<EgressProgressDecision, LiveKitWebhookDecisionError> {
  const failureCode = egressFailureCode(observation.status);
  if (failureCode !== null) return ok({ kind: "fail_artifact", errorCode: failureCode });
  if (observation.status !== "active") {
    return ok({ kind: "acknowledge", outcome: "egress_observation_acknowledged" });
  }
  if (state.data.artifact.status !== ArtifactStatus.Pending) {
    return ok({ kind: "acknowledge", outcome: "recording_already_observed" });
  }
  if (state.tag !== ConversationStateTag.Starting) return err("conversation_not_ready");
  if (!isValidEgressId(observation.egressId)) return err("invalid_egress");
  return ok({ kind: "recording_started", recordingId: observation.egressId });
}

export function decideMediaObservationKind(
  observation: DecodedMediaWebhook,
  knownAgentIdentity: string | null,
): LiveKitMediaObservationKind | null {
  const isBrowser = observation.participantIdentity === `browser-${observation.conversationId}`;
  const isAgent =
    observation.participantIsAgent || observation.participantIdentity === knownAgentIdentity;
  if (!isBrowser && !isAgent) return null;

  switch (observation.eventType) {
    case "participant_joined":
      return isBrowser ? "browser_participant_joined" : "agent_participant_joined";
    case "participant_left":
    case "participant_connection_aborted":
      return isBrowser ? "browser_participant_left" : "agent_participant_left";
    case "track_published":
    case "track_unpublished":
      if (!observation.microphoneAudio) return null;
      if (isBrowser) {
        return observation.eventType === "track_published"
          ? "browser_audio_published"
          : "browser_audio_unpublished";
      }
      return observation.eventType === "track_published"
        ? "agent_audio_published"
        : "agent_audio_unpublished";
    default:
      return null;
  }
}

export function isNegativeMediaObservation(kind: LiveKitMediaObservationKind): boolean {
  return kind.endsWith("_left") || kind.endsWith("_unpublished");
}

export function decideRoomFinished(state: ConversationState): RoomFinishedDecision {
  const transport = state.data.transport;
  if (transport.status === TransportStatus.Closed || transport.status === TransportStatus.Failed) {
    return { kind: "acknowledge", outcome: "transport_already_terminal" };
  }
  if (transport.status === TransportStatus.Idle) {
    return { kind: "acknowledge", outcome: "room_finished_before_start" };
  }
  return { kind: "close_session", epoch: transport.epoch };
}

export function decideArtifactFailure(
  observation: DecodedEgressWebhook,
  state: ConversationState,
  errorCode: string,
): ArtifactFailureDecision {
  if (
    (state.tag === ConversationStateTag.Ending && state.data.target.kind === "cancel") ||
    state.data.artifact.status === ArtifactStatus.Failed ||
    state.data.artifact.status === ArtifactStatus.Ready ||
    state.tag === ConversationStateTag.Completed ||
    state.tag === ConversationStateTag.Cancelled ||
    state.tag === ConversationStateTag.Failed
  ) {
    return { kind: "acknowledge", outcome: "artifact_terminal" };
  }
  return {
    kind: "apply",
    recordingId: observation.egressId.length === 0 ? null : observation.egressId,
    errorCode,
  };
}

export function completedEgressRecording(
  observation: DecodedEgressWebhook,
): Result<CompletedEgressRecording, LiveKitWebhookDecisionError> {
  if (!isValidEgressId(observation.egressId)) return err("invalid_egress");
  const filenames = observation.outputFilenames.filter((filename) => filename.length > 0);
  if (filenames.length !== 1) return err("invalid_output_count");
  const key = filenames[0];
  const prefix = `conversations/${observation.conversationId}/`;
  if (
    key === undefined ||
    key.length > 1024 ||
    !key.startsWith(prefix) ||
    key.includes("..") ||
    key.endsWith("/")
  ) {
    return err("invalid_output_key");
  }
  return ok({ recordingId: observation.egressId, r2Key: key });
}

export function egressFailureCode(status: LiveKitEgressStatus): string | null {
  switch (status) {
    case "aborted":
      return "artifact.livekit_egress_aborted";
    case "limit_reached":
      return "artifact.livekit_egress_limit_reached";
    case "failed":
      return "artifact.livekit_egress_failed";
    default:
      return null;
  }
}

function isValidEgressId(egressId: string): boolean {
  return egressId.length > 0 && egressId.length <= 256;
}

function decodeEgressStatus(status: EgressStatus): LiveKitEgressStatus {
  switch (status) {
    case EgressStatus.EGRESS_STARTING:
      return "starting";
    case EgressStatus.EGRESS_ACTIVE:
      return "active";
    case EgressStatus.EGRESS_ENDING:
      return "ending";
    case EgressStatus.EGRESS_COMPLETE:
      return "complete";
    case EgressStatus.EGRESS_FAILED:
      return "failed";
    case EgressStatus.EGRESS_ABORTED:
      return "aborted";
    case EgressStatus.EGRESS_LIMIT_REACHED:
      return "limit_reached";
    default:
      return "other";
  }
}
