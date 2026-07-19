import { describe, expect, it } from "vitest";

import { deadlineEventForState, deadlineForState } from "../src/domain/conversation-deadlines";
import {
  ConversationEventType,
  createConversation,
  transitionRuntime,
  value,
  type ConversationState,
} from "../src/domain/conversation-state-machine";

const at = value.unixMillis;
const apply = transitionRuntime;

function live(): ConversationState {
  let state: ConversationState = createConversation(value.conversationSessionId("deadline"), at(0));
  state = apply(state, {
    type: ConversationEventType.StartRequested,
    eventId: "start",
    at: at(1),
    startDeadlineAt: at(1_000),
  });
  state = apply(state, {
    type: ConversationEventType.TransportConnected,
    eventId: "connected",
    at: at(2),
    epoch: 1,
  });
  state = apply(state, {
    type: ConversationEventType.RecordingStarted,
    eventId: "recording",
    at: at(3),
    recordingId: value.recordingId("recording"),
  });
  return apply(state, {
    type: ConversationEventType.SessionStarted,
    eventId: "ready",
    at: at(4),
    epoch: 1,
    maximumEndAt: at(50_000),
  });
}

describe("conversation deadlines", () => {
  it("selects the starting deadline and emits its timeout", () => {
    const state = apply(createConversation(value.conversationSessionId("starting"), at(0)), {
      type: ConversationEventType.StartRequested,
      eventId: "start",
      at: at(1),
      startDeadlineAt: at(1_000),
    });
    expect(deadlineForState(state)).toBe(at(1_000));
    expect(deadlineEventForState(state, at(1_001))).toMatchObject({
      type: ConversationEventType.StartingDeadlineExceeded,
    });
  });

  it("chooses the reconnect deadline before the later live-duration deadline", () => {
    const state = apply(live(), {
      type: ConversationEventType.TransportInterrupted,
      eventId: "interrupt",
      at: at(10),
      epoch: 1,
      errorCode: value.errorCode("lost"),
      recoveryDeadlineAt: at(20_010),
    });
    expect(deadlineForState(state)).toBe(at(20_010));
    expect(deadlineEventForState(state, at(20_010))).toMatchObject({
      type: ConversationEventType.RecoveryDeadlineExceeded,
    });
  });

  it("uses live duration when it is earlier than recovery", () => {
    let state = live();
    state = apply(state, {
      type: ConversationEventType.TransportInterrupted,
      eventId: "interrupt",
      at: at(10),
      epoch: 1,
      errorCode: value.errorCode("lost"),
      recoveryDeadlineAt: at(60_000),
    });
    expect(deadlineForState(state)).toBe(at(50_000));
    expect(deadlineEventForState(state, at(50_000))).toMatchObject({
      type: ConversationEventType.TimeLimitReached,
    });
  });

  it("selects the earliest active ending and artifact-upload deadline", () => {
    let state = apply(live(), {
      type: ConversationEventType.EndRequested,
      eventId: "end",
      at: at(5),
      reason: "done",
      endingDeadlineAt: at(1_000),
    });
    state = apply(state, {
      type: ConversationEventType.RecordingUploadStarted,
      eventId: "upload",
      at: at(6),
      recordingId: value.recordingId("recording"),
      expectedR2Key: value.r2ObjectKey("recording.webm"),
      artifactDeadlineAt: at(500),
    });
    expect(deadlineForState(state)).toBe(at(500));
    expect(deadlineEventForState(state, at(500))).toMatchObject({
      type: ConversationEventType.ArtifactDeadlineExceeded,
    });
  });

  it("has no deadline for terminal states", () => {
    const state = apply(createConversation(value.conversationSessionId("cancelled"), at(0)), {
      type: ConversationEventType.EndRequested,
      eventId: "cancel",
      at: at(1),
      reason: "cancelled",
      endingDeadlineAt: at(10),
    });
    expect(deadlineForState(state)).toBeNull();
    expect(deadlineEventForState(state, at(10))).toBeNull();
  });
});
