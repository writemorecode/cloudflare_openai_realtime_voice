/** Pure composite-readiness policy for LiveKit and agent evidence. */
import { MAXIMUM_LIVE_DURATION_MS } from "../../../domain/conversation-deadlines";
import {
  ArtifactStatus,
  ConversationEventType,
  ConversationStateTag,
  TransportStatus,
  value,
  type ConversationEvent,
  type ConversationState,
} from "../../../domain/conversation-state-machine";
import type { LiveKitTransportEvidence } from "../../../durable-object/conversation-session";

export function nextReadinessEvent(
  state: ConversationState,
  evidence: LiveKitTransportEvidence | null,
  observedAt: number,
): ConversationEvent | null {
  if (evidence === null || !isCompositeTransportReady(evidence)) return null;

  if (
    state.tag === ConversationStateTag.Live &&
    state.data.transport.status === TransportStatus.Reconnecting &&
    evidence.transportEpoch === state.data.transport.epoch + 1
  ) {
    return {
      type: ConversationEventType.TransportConnected,
      eventId: readinessEventId(state, evidence.transportEpoch, "transport-connected"),
      at: value.unixMillis(observedAt),
      epoch: evidence.transportEpoch,
    };
  }

  if (
    state.tag === ConversationStateTag.Starting &&
    state.data.transport.status === TransportStatus.Connecting &&
    state.data.transport.epoch === evidence.transportEpoch
  ) {
    return {
      type: ConversationEventType.TransportConnected,
      eventId: readinessEventId(state, evidence.transportEpoch, "transport-connected"),
      at: value.unixMillis(observedAt),
      epoch: evidence.transportEpoch,
    };
  }

  if (
    state.tag === ConversationStateTag.Starting &&
    state.data.transport.status === TransportStatus.Connected &&
    state.data.transport.epoch === evidence.transportEpoch &&
    state.data.artifact.status === ArtifactStatus.Recording
  ) {
    return {
      type: ConversationEventType.SessionStarted,
      eventId: readinessEventId(state, evidence.transportEpoch, "session-started"),
      at: value.unixMillis(observedAt),
      epoch: evidence.transportEpoch,
      maximumEndAt: value.unixMillis(observedAt + MAXIMUM_LIVE_DURATION_MS),
    };
  }

  return null;
}

export function isCompositeTransportReady(evidence: LiveKitTransportEvidence): boolean {
  return (
    evidence.browserParticipantActive &&
    evidence.browserAudioPublished &&
    evidence.agentParticipantActive &&
    evidence.agentAudioPublished &&
    evidence.realtimeReady
  );
}

function readinessEventId(
  state: ConversationState,
  epoch: number,
  kind: "transport-connected" | "session-started",
): string {
  return `system:livekit:${state.data.sessionId}:${epoch}:${kind}`;
}
