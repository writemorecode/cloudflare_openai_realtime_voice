/** Reconciles provider evidence into composite, provider-neutral transport readiness transitions. */
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
import type {
  ConversationSession,
  LiveKitTransportEvidence,
} from "../../../durable-object/conversation-session";
import { ApiError } from "../../http/api-errors";
import { applyIntegrationEventWithRetry } from "./integration-event-retry";

export async function reconcileCompositeReadiness(
  stub: DurableObjectStub<ConversationSession>,
  observedAt: number,
): Promise<ConversationState> {
  let state = await requiredState(stub);
  const evidence = await stub.getLiveKitTransportEvidence();
  if (evidence === null || !isCompositeTransportReady(evidence)) return state;

  if (
    state.tag === ConversationStateTag.Live &&
    state.data.transport.status === TransportStatus.Reconnecting &&
    evidence.transportEpoch === state.data.transport.epoch + 1
  ) {
    state = await applyIntegrationEvent(stub, state, {
      type: ConversationEventType.TransportConnected,
      eventId: readinessEventId(state, evidence.transportEpoch, "transport-connected"),
      at: value.unixMillis(observedAt),
      epoch: evidence.transportEpoch,
    });
  }

  if (
    state.tag === ConversationStateTag.Starting &&
    state.data.transport.status === TransportStatus.Connecting &&
    state.data.transport.epoch === evidence.transportEpoch
  ) {
    state = await applyIntegrationEvent(stub, state, {
      type: ConversationEventType.TransportConnected,
      eventId: readinessEventId(state, evidence.transportEpoch, "transport-connected"),
      at: value.unixMillis(observedAt),
      epoch: evidence.transportEpoch,
    });
  }

  if (
    state.tag === ConversationStateTag.Starting &&
    state.data.transport.status === TransportStatus.Connected &&
    state.data.transport.epoch === evidence.transportEpoch &&
    state.data.artifact.status === ArtifactStatus.Recording
  ) {
    state = await applyIntegrationEvent(stub, state, {
      type: ConversationEventType.SessionStarted,
      eventId: readinessEventId(state, evidence.transportEpoch, "session-started"),
      at: value.unixMillis(observedAt),
      epoch: evidence.transportEpoch,
      maximumEndAt: value.unixMillis(observedAt + MAXIMUM_LIVE_DURATION_MS),
    });
  }
  return state;
}

function isCompositeTransportReady(evidence: LiveKitTransportEvidence): boolean {
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

async function requiredState(
  stub: DurableObjectStub<ConversationSession>,
): Promise<ConversationState> {
  const state = await stub.getState();
  if (state === null) throw new ApiError(404, "conversation_not_found", "Conversation not found.");
  return state;
}

async function applyIntegrationEvent(
  stub: DurableObjectStub<ConversationSession>,
  initial: ConversationState,
  event: ConversationEvent,
): Promise<ConversationState> {
  return applyIntegrationEventWithRetry(stub, initial, event, {
    rejected: () =>
      new ApiError(409, "readiness_transition_rejected", "Readiness could not be applied."),
    exhausted: () =>
      new ApiError(409, "readiness_transition_conflict", "Readiness could not be applied."),
  });
}
