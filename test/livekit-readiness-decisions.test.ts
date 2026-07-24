import { describe, expect, it } from "vitest";

import {
  ConversationEventType,
  createConversation,
  value,
  type LiveState,
  type StartingState,
} from "../src/domain/conversation-state-machine";
import { transition } from "./transition-test-utils";
import type { LiveKitTransportEvidence } from "../src/durable-object/conversation-session";
import {
  isCompositeTransportReady,
  nextReadinessEvent,
} from "../src/worker/integrations/livekit/readiness-decisions";

const CONVERSATION_ID = "12345678-1234-8234-9234-123456789abc";
const OBSERVED_AT = 1_700_000_000_000;

function starting(): StartingState {
  return transition(
    createConversation(value.conversationSessionId(CONVERSATION_ID), value.unixMillis(1)),
    {
      type: ConversationEventType.StartRequested,
      eventId: "start",
      at: value.unixMillis(2),
      startDeadlineAt: value.unixMillis(60_002),
    },
  );
}

function evidence(transportEpoch = 1): LiveKitTransportEvidence {
  return {
    transportEpoch,
    browserParticipantActive: true,
    browserAudioPublished: true,
    agentParticipantActive: true,
    agentParticipantIdentity: "agent-runtime",
    agentAudioPublished: true,
    realtimeReady: true,
    realtimeReadyEventId: "agent:ready",
  };
}

function live(): LiveState {
  let state = transition(starting(), {
    type: ConversationEventType.TransportConnected,
    eventId: "connected",
    at: value.unixMillis(3),
    epoch: 1,
  });
  state = transition(state, {
    type: ConversationEventType.RecordingStarted,
    eventId: "recording",
    at: value.unixMillis(4),
    recordingId: value.recordingId("EG_test"),
  });
  return transition(state, {
    type: ConversationEventType.SessionStarted,
    eventId: "session-started",
    at: value.unixMillis(5),
    epoch: 1,
    maximumEndAt: value.unixMillis(60_005),
  });
}

describe("LiveKit readiness decisions", () => {
  it("requires every independent readiness signal", () => {
    expect(isCompositeTransportReady(evidence())).toBe(true);
    expect(isCompositeTransportReady({ ...evidence(), agentAudioPublished: false })).toBe(false);
    expect(isCompositeTransportReady({ ...evidence(), realtimeReady: false })).toBe(false);
  });

  it("connects a starting transport when composite evidence is ready", () => {
    expect(nextReadinessEvent(starting(), evidence(), OBSERVED_AT)).toMatchObject({
      type: ConversationEventType.TransportConnected,
      eventId: `system:livekit:${CONVERSATION_ID}:1:transport-connected`,
      epoch: 1,
      at: OBSERVED_AT,
    });
  });

  it("starts the session only after recording is active", () => {
    const connected = transition(starting(), {
      type: ConversationEventType.TransportConnected,
      eventId: "connected",
      at: value.unixMillis(3),
      epoch: 1,
    });
    expect(nextReadinessEvent(connected, evidence(), OBSERVED_AT)).toBeNull();

    const recording = transition(connected, {
      type: ConversationEventType.RecordingStarted,
      eventId: "recording",
      at: value.unixMillis(4),
      recordingId: value.recordingId("EG_test"),
    });
    expect(nextReadinessEvent(recording, evidence(), OBSERVED_AT)).toMatchObject({
      type: ConversationEventType.SessionStarted,
      epoch: 1,
      at: OBSERVED_AT,
    });
  });

  it("accepts only next-epoch evidence while reconnecting", () => {
    const reconnecting = transition(live(), {
      type: ConversationEventType.TransportInterrupted,
      eventId: "interrupted",
      at: value.unixMillis(10),
      epoch: 1,
      errorCode: value.errorCode("transport.interrupted"),
      recoveryDeadlineAt: value.unixMillis(20_010),
    });

    expect(nextReadinessEvent(reconnecting, evidence(1), OBSERVED_AT)).toBeNull();
    expect(nextReadinessEvent(reconnecting, evidence(2), OBSERVED_AT)).toMatchObject({
      type: ConversationEventType.TransportConnected,
      epoch: 2,
    });
  });
});
