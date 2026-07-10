import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ConversationEventType,
  ConversationStateTag,
  RecoverableConnection,
  StopReason,
  TransitionGuardError,
  createConversation,
  transition,
  value,
  type AwaitingBridgeState,
  type LiveState,
  type ProvisioningState,
  type StartingRecordingState,
  type StoppingState,
} from "../src/conversation-state-machine";

const at = value.unixMillis;
const sessionId = value.conversationSessionId("conversation-1");

const startRequested = {
  type: ConversationEventType.StartRequested,
  eventId: "event-start",
  at: at(1_000),
  provisioningDeadlineAt: at(5_000),
} as const;

const recordingConfirmed = {
  type: ConversationEventType.RecordingConfirmed,
  eventId: "event-recording-confirmed",
  at: at(5_000),
  recordingId: value.recordingId("recording-1"),
  maximumEndAt: at(1_205_000),
} as const;

function awaitingBridge(): AwaitingBridgeState {
  const created = createConversation(sessionId, at(0));
  const provisioning = transition(created, startRequested);

  return transition(provisioning, {
    type: ConversationEventType.ResourcesProvisioned,
    eventId: "event-resources",
    at: at(2_000),
    resources: {
      meetingId: value.realtimeKitMeetingId("meeting-1"),
      humanParticipantId: value.participantId("human-1"),
      agentParticipantId: value.participantId("agent-1"),
      bridgeGeneration: 1,
    },
    readinessDeadlineAt: at(10_000),
  });
}

function startingRecording(): StartingRecordingState {
  const waiting = awaitingBridge();
  const ready = transition(waiting, {
    type: ConversationEventType.BridgeProgressed,
    eventId: "event-bridge-progress",
    at: at(3_000),
    bridgeGeneration: 1,
    readiness: {
      humanJoined: true,
      agentJoined: true,
      openAiConnected: true,
      sidebandConnected: true,
      agentTrackPublished: true,
    },
  });

  return transition(ready, {
    type: ConversationEventType.BridgeReady,
    eventId: "event-bridge-ready",
    at: at(4_000),
    bridgeGeneration: 1,
    realtimeKitSessionId: value.realtimeKitSessionId("rtk-session-1"),
    openAiCallId: value.openAiCallId("openai-call-1"),
    recordingRequestId: value.recordingRequestId("recording-request-1"),
    recordingStartDeadlineAt: at(8_000),
  });
}

function live(): LiveState {
  return transition(startingRecording(), recordingConfirmed);
}

describe("conversation state machine typing", () => {
  it("infers the exact target state for a legal transition", () => {
    const created = createConversation(sessionId, at(0));
    const provisioning = transition(created, startRequested);

    expectTypeOf(provisioning).toEqualTypeOf<ProvisioningState>();
    expect(provisioning.tag).toBe(ConversationStateTag.Provisioning);
  });
});

describe("conversation state machine guards", () => {
  it("requires complete bridge readiness before starting recording", () => {
    const waiting = awaitingBridge();

    expect(() =>
      transition(waiting, {
        type: ConversationEventType.BridgeReady,
        eventId: "event-too-early",
        at: at(3_000),
        bridgeGeneration: 1,
        realtimeKitSessionId: value.realtimeKitSessionId("rtk-session-1"),
        openAiCallId: value.openAiCallId("openai-call-1"),
        recordingRequestId: value.recordingRequestId("recording-request-1"),
        recordingStartDeadlineAt: at(8_000),
      }),
    ).toThrowError(TransitionGuardError);
  });

  it("moves a live conversation into recovery without losing live resources", () => {
    const active = live();
    const recovering = transition(active, {
      type: ConversationEventType.RecoverableConnectionLost,
      eventId: "event-sideband-lost",
      at: at(6_000),
      connection: RecoverableConnection.OpenAiSideband,
      recoveryDeadlineAt: at(12_000),
    });

    expect(recovering.tag).toBe(ConversationStateTag.Recovering);
    expect(recovering.data.live.resources.recordingId).toBe(active.data.resources.recordingId);
  });

  it("hard-stops a live conversation when recording fails", () => {
    const active = live();
    const stopping = transition(active, {
      type: ConversationEventType.RecordingFailed,
      eventId: "event-recording-failed",
      at: at(7_000),
      recordingId: active.data.resources.recordingId,
      errorCode: value.errorCode("recording_failed"),
      shutdownDeadlineAt: at(15_000),
    });

    expectTypeOf(stopping).toEqualTypeOf<StoppingState>();
    expect(stopping.data.reason).toBe(StopReason.RecordingFailed);
    expect(stopping.data.recording.kind).toBe("errored");
  });
});
