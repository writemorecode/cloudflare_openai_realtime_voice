import { WebhookEvent } from "livekit-server-sdk";
import { describe, expect, it } from "vitest";

import {
  ConversationEventType,
  createConversation,
  value,
  type CreatedState,
  type StartingState,
} from "../src/domain/conversation-state-machine";
import { transition } from "./transition-test-utils";
import {
  completedEgressRecording,
  decideArtifactFailure,
  decideEgressProgress,
  decideMediaObservationKind,
  decideRoomFinished,
  decodeLiveKitWebhook,
  type DecodedEgressWebhook,
  type DecodedMediaWebhook,
} from "../src/worker/integrations/livekit/webhook-decisions";

const CONVERSATION_ID = "12345678-1234-8234-9234-123456789abc";
const ROOM_NAME = `conversation-${CONVERSATION_ID}`;
const EVENT_ID = "EV_123456789012";

function webhook(payload: Record<string, unknown>): WebhookEvent {
  return WebhookEvent.fromJson({ id: EVENT_ID, createdAt: "1", ...payload });
}

function created(): CreatedState {
  return createConversation(value.conversationSessionId(CONVERSATION_ID), value.unixMillis(1));
}

function starting(): StartingState {
  return transition(created(), {
    type: ConversationEventType.StartRequested,
    eventId: "start",
    at: value.unixMillis(2),
    startDeadlineAt: value.unixMillis(60_002),
  });
}

function decodedEgress(payload: Record<string, unknown>): DecodedEgressWebhook {
  const decoded = decodeLiveKitWebhook(webhook(payload));
  if (
    !decoded.isOk() ||
    (decoded.value.kind !== "egress_progress" && decoded.value.kind !== "egress_ended")
  ) {
    expect.fail("expected decoded egress webhook");
  }
  return decoded.value;
}

function decodedMedia(payload: Record<string, unknown>): DecodedMediaWebhook {
  const decoded = decodeLiveKitWebhook(webhook(payload));
  if (!decoded.isOk() || decoded.value.kind !== "media") {
    expect.fail("expected decoded media webhook");
  }
  return decoded.value;
}

describe("LiveKit webhook decisions", () => {
  it("decodes provider egress payloads into an internal observation", () => {
    expect(
      decodeLiveKitWebhook(
        webhook({
          event: "egress_started",
          egressInfo: { egressId: "EG_test", roomName: ROOM_NAME, status: "EGRESS_ACTIVE" },
        }),
      ),
    ).toEqual({
      status: "ok",
      value: {
        kind: "egress_progress",
        eventId: EVENT_ID,
        eventType: "egress_started",
        conversationId: CONVERSATION_ID,
        roomName: ROOM_NAME,
        egressId: "EG_test",
        status: "active",
        outputFilenames: [],
      },
    });
  });

  it("acknowledges room-started webhooks without requiring a participant payload", () => {
    expect(
      decodeLiveKitWebhook(
        webhook({
          event: "room_started",
          room: { name: ROOM_NAME },
        }),
      ),
    ).toEqual({
      status: "ok",
      value: {
        kind: "acknowledged",
        eventId: EVENT_ID,
        eventType: "room_started",
        conversationId: CONVERSATION_ID,
        roomName: ROOM_NAME,
      },
    });
  });

  it("rejects invalid event and room correlation before any stateful work", () => {
    expect(
      decodeLiveKitWebhook(
        WebhookEvent.fromJson({
          id: "bad",
          event: "room_finished",
          room: { name: ROOM_NAME },
        }),
      ),
    ).toEqual({ status: "error", error: "invalid_event" });
    expect(
      decodeLiveKitWebhook(
        webhook({
          event: "egress_started",
          room: { name: ROOM_NAME },
          egressInfo: {
            egressId: "EG_test",
            roomName: "conversation-e570d451-98dc-4ba8-867b-735c652114b7",
            status: "EGRESS_ACTIVE",
          },
        }),
      ),
    ).toEqual({ status: "error", error: "room_mismatch" });
  });

  it("classifies browser, agent, and irrelevant media observations", () => {
    const browser = decodedMedia({
      event: "track_published",
      room: { name: ROOM_NAME },
      participant: { identity: `browser-${CONVERSATION_ID}`, kind: "STANDARD" },
      track: { type: "AUDIO", source: "MICROPHONE" },
    });
    const agent = decodedMedia({
      event: "participant_joined",
      room: { name: ROOM_NAME },
      participant: { identity: "agent-runtime", kind: "AGENT" },
    });
    const unrelated = decodedMedia({
      event: "participant_joined",
      room: { name: ROOM_NAME },
      participant: { identity: "observer", kind: "STANDARD" },
    });

    expect(decideMediaObservationKind(browser, null)).toBe("browser_audio_published");
    expect(decideMediaObservationKind(agent, null)).toBe("agent_participant_joined");
    expect(decideMediaObservationKind(unrelated, null)).toBeNull();
    expect(decideMediaObservationKind(unrelated, "observer")).toBe("agent_participant_joined");
  });

  it("plans recording start and egress failure without performing effects", () => {
    const active = decodedEgress({
      event: "egress_started",
      egressInfo: { egressId: "EG_test", roomName: ROOM_NAME, status: "EGRESS_ACTIVE" },
    });
    const failed = decodedEgress({
      event: "egress_updated",
      egressInfo: { egressId: "EG_test", roomName: ROOM_NAME, status: "EGRESS_FAILED" },
    });

    expect(decideEgressProgress(active, starting())).toEqual({
      status: "ok",
      value: { kind: "recording_started", recordingId: "EG_test" },
    });
    expect(decideEgressProgress(failed, starting())).toEqual({
      status: "ok",
      value: { kind: "fail_artifact", errorCode: "artifact.livekit_egress_failed" },
    });
  });

  it("validates the completed recording key deterministically", () => {
    const completed = decodedEgress({
      event: "egress_ended",
      egressInfo: {
        egressId: "EG_test",
        roomName: ROOM_NAME,
        status: "EGRESS_COMPLETE",
        fileResults: [{ filename: `conversations/${CONVERSATION_ID}/recording.ogg` }],
      },
    });
    const traversal = {
      ...completed,
      outputFilenames: [`conversations/${CONVERSATION_ID}/../other.ogg`],
    };

    expect(completedEgressRecording(completed)).toEqual({
      status: "ok",
      value: {
        recordingId: "EG_test",
        r2Key: `conversations/${CONVERSATION_ID}/recording.ogg`,
      },
    });
    expect(completedEgressRecording(traversal)).toEqual({
      status: "error",
      error: "invalid_output_key",
    });
  });

  it("makes terminal-state decisions without Durable Object calls", () => {
    const failed = decodedEgress({
      event: "egress_updated",
      egressInfo: { egressId: "EG_test", roomName: ROOM_NAME, status: "EGRESS_FAILED" },
    });

    expect(decideArtifactFailure(failed, starting(), "artifact.failed")).toEqual({
      kind: "apply",
      recordingId: "EG_test",
      errorCode: "artifact.failed",
    });
    expect(decideRoomFinished(created())).toEqual({
      kind: "acknowledge",
      outcome: "room_finished_before_start",
    });
    expect(decideRoomFinished(starting())).toEqual({ kind: "close_session", epoch: 1 });
  });
});
