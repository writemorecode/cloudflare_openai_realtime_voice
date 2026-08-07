import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ArtifactStatus,
  ConversationEventType,
  ConversationStateTag,
  FailureStage,
  StopReason,
  TransportStatus,
  createConversation,
  transition as transitionResult,
  transitionRuntime as transitionRuntimeResult,
  value,
  type CompletedState,
  type LiveState,
  type StartingState,
} from "../src/domain/conversation-state-machine";
import { transition, transitionRuntime } from "./transition-test-utils";

const at = value.unixMillis;
const sessionId = value.conversationSessionId("conversation-1");

function starting(): StartingState {
  return transition(createConversation(sessionId, at(0)), {
    type: ConversationEventType.StartRequested,
    eventId: "start",
    at: at(1),
    startDeadlineAt: at(1_000),
  });
}

function live(): LiveState {
  let state = transition(starting(), {
    type: ConversationEventType.TransportConnected,
    eventId: "connected",
    at: at(2),
    epoch: 1,
  });
  state = transition(state, {
    type: ConversationEventType.RecordingStarted,
    eventId: "recording",
    at: at(3),
    recordingId: value.recordingId("recording-1"),
  });
  return transition(state, {
    type: ConversationEventType.SessionStarted,
    eventId: "session-ready",
    at: at(4),
    epoch: 1,
    maximumEndAt: at(10_000),
  });
}

function ending() {
  return transition(live(), {
    type: ConversationEventType.EndRequested,
    eventId: "end",
    at: at(5),
    reason: "done",
    endingDeadlineAt: at(2_000),
  });
}

describe("conversation aggregate transitions", () => {
  it("starts with connecting transport at epoch one", () => {
    const state = starting();
    expectTypeOf(state).toEqualTypeOf<StartingState>();
    expect(state).toMatchObject({
      tag: ConversationStateTag.Starting,
      revision: 1,
      data: {
        transport: { status: TransportStatus.Connecting, epoch: 1 },
        artifact: { status: ArtifactStatus.Pending },
      },
    });
  });

  it("requires connected transport and active recording before going live", () => {
    const initial = starting();
    const tooEarly = transitionResult(initial, {
      type: ConversationEventType.SessionStarted,
      eventId: "too-early",
      at: at(2),
      epoch: 1,
      maximumEndAt: at(100),
    });
    expect(tooEarly).toMatchObject({
      status: "error",
      error: { kind: "guard_failed", reason: "transport must be connected at the supplied epoch" },
    });

    const connected = transition(initial, {
      type: ConversationEventType.TransportConnected,
      eventId: "connected-only",
      at: at(2),
      epoch: 1,
    });
    const noRecording = transitionResult(connected, {
      type: ConversationEventType.SessionStarted,
      eventId: "no-recording",
      at: at(3),
      epoch: 1,
      maximumEndAt: at(100),
    });
    expect(noRecording).toMatchObject({
      status: "error",
      error: { kind: "guard_failed", reason: "artifact must be recording" },
    });

    expect(live()).toMatchObject({
      tag: ConversationStateTag.Live,
      data: {
        transport: { status: TransportStatus.Connected, epoch: 1 },
        artifact: { status: ArtifactStatus.Recording },
      },
    });
  });

  it("keeps lifecycle live while reconnecting and increments the epoch on recovery", () => {
    const interrupted = transition(live(), {
      type: ConversationEventType.TransportInterrupted,
      eventId: "interrupt-1",
      at: at(10),
      epoch: 1,
      errorCode: value.errorCode("network.lost"),
      recoveryDeadlineAt: at(20_010),
    });
    const observedAgain = transition(interrupted, {
      type: ConversationEventType.TransportInterrupted,
      eventId: "interrupt-2",
      at: at(11),
      epoch: 1,
      errorCode: value.errorCode("network.still_lost"),
      recoveryDeadlineAt: at(99_999),
    });
    expect(observedAgain.tag).toBe(ConversationStateTag.Live);
    expect(observedAgain.data.transport).toMatchObject({
      status: TransportStatus.Reconnecting,
      epoch: 1,
      attempt: 2,
      deadlineAt: at(20_010),
    });

    const badEpoch = transitionResult(observedAgain, {
      type: ConversationEventType.TransportConnected,
      eventId: "bad-epoch",
      at: at(12),
      epoch: 1,
    });
    expect(badEpoch).toMatchObject({
      status: "error",
      error: { kind: "guard_failed", reason: "reconnect epoch must increment by one" },
    });
    const restored = transition(observedAgain, {
      type: ConversationEventType.TransportConnected,
      eventId: "restored",
      at: at(13),
      epoch: 2,
    });
    expect(restored.data.transport).toMatchObject({ status: TransportStatus.Connected, epoch: 2 });
  });

  it("fails a live conversation when recovery times out", () => {
    const reconnecting = transition(live(), {
      type: ConversationEventType.TransportInterrupted,
      eventId: "interrupt",
      at: at(10),
      epoch: 1,
      errorCode: value.errorCode("network.lost"),
      recoveryDeadlineAt: at(20_010),
    });
    const failed = transition(reconnecting, {
      type: ConversationEventType.RecoveryDeadlineExceeded,
      eventId: "timeout",
      at: at(20_010),
      errorCode: value.errorCode("deadline.recovery_exceeded"),
      endingDeadlineAt: at(35_010),
    });
    expect(failed).toMatchObject({
      tag: ConversationStateTag.Failed,
      data: {
        stage: FailureStage.Transport,
        transport: { status: TransportStatus.Failed },
      },
    });
  });

  it("completes when the artifact becomes ready before transport closes", () => {
    const uploading = transition(ending(), {
      type: ConversationEventType.RecordingUploadStarted,
      eventId: "upload",
      at: at(6),
      recordingId: value.recordingId("recording-1"),
      expectedR2Key: value.r2ObjectKey("recordings/1.webm"),
      artifactDeadlineAt: at(5_000),
    });
    const state = transition(uploading, {
      type: ConversationEventType.RecordingArtifactVerified,
      eventId: "ready",
      at: at(7),
      recordingId: value.recordingId("recording-1"),
      r2Key: value.r2ObjectKey("recordings/1.webm"),
      r2Etag: value.r2Etag("etag-1"),
    });
    expect(state.tag).toBe(ConversationStateTag.Ending);
    if (state.tag !== ConversationStateTag.Ending) expect.fail("expected ending state");
    const completed = transition(state, {
      type: ConversationEventType.SessionClosed,
      eventId: "closed",
      at: at(8),
      epoch: 1,
    });
    expectTypeOf(completed).toEqualTypeOf<
      | import("../src/domain/conversation-state-machine").EndingState
      | CompletedState
      | import("../src/domain/conversation-state-machine").CancelledState
      | import("../src/domain/conversation-state-machine").FailedState
    >();
    expect(completed).toMatchObject({
      tag: ConversationStateTag.Completed,
      data: { terminationReason: StopReason.UserRequested },
    });
  });

  it("completes when transport closes before the artifact becomes ready", () => {
    let state: import("../src/domain/conversation-state-machine").ConversationState = transition(
      ending(),
      {
        type: ConversationEventType.RecordingUploadStarted,
        eventId: "upload",
        at: at(6),
        recordingId: value.recordingId("recording-1"),
        expectedR2Key: value.r2ObjectKey("recordings/1.webm"),
        artifactDeadlineAt: at(5_000),
      },
    );
    state = transitionRuntime(state, {
      type: ConversationEventType.SessionClosed,
      eventId: "closed",
      at: at(7),
      epoch: 1,
    });
    expect(state.tag).toBe(ConversationStateTag.Ending);
    const completed = transitionRuntime(state, {
      type: ConversationEventType.RecordingArtifactVerified,
      eventId: "ready",
      at: at(8),
      recordingId: value.recordingId("recording-1"),
      r2Key: value.r2ObjectKey("recordings/1.webm"),
      r2Etag: value.r2Etag("etag-1"),
    });
    expect(completed.tag).toBe(ConversationStateTag.Completed);
  });

  it("cancels before live without requiring an artifact", () => {
    const endingState = transition(starting(), {
      type: ConversationEventType.EndRequested,
      eventId: "cancel",
      at: at(2),
      reason: "user_requested",
      endingDeadlineAt: at(100),
    });
    const cancelled = transition(endingState, {
      type: ConversationEventType.SessionClosed,
      eventId: "closed",
      at: at(3),
      epoch: 1,
    });
    expect(cancelled.tag).toBe(ConversationStateTag.Cancelled);
    expect(cancelled.data.artifact.status).toBe(ArtifactStatus.Pending);
  });

  it("turns artifact failure into failed shutdown without requiring readiness", () => {
    const endingState = transition(live(), {
      type: ConversationEventType.ArtifactFailed,
      eventId: "artifact-failed",
      at: at(5),
      recordingId: value.recordingId("recording-1"),
      errorCode: value.errorCode("artifact.recording_failed"),
      endingDeadlineAt: at(100),
    });
    const failed = transition(endingState, {
      type: ConversationEventType.SessionClosed,
      eventId: "closed",
      at: at(6),
      epoch: 1,
    });
    expect(failed).toMatchObject({
      tag: ConversationStateTag.Failed,
      data: { stage: FailureStage.Artifact, artifact: { status: ArtifactStatus.Failed } },
    });
  });

  it("rejects events from terminal states", () => {
    const cancelled = transition(createConversation(sessionId, at(0)), {
      type: ConversationEventType.EndRequested,
      eventId: "cancel-created",
      at: at(1),
      reason: "never_started",
      endingDeadlineAt: at(10),
    });
    const rejected = transitionRuntimeResult(cancelled, {
      type: ConversationEventType.StartRequested,
      eventId: "too-late",
      at: at(2),
      startDeadlineAt: at(10),
    });
    expect(rejected).toMatchObject({ status: "error", error: { kind: "illegal_transition" } });
  });
});
