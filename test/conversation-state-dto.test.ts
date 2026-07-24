import { describe, expect, it } from "vitest";
import { conversationStateSchema } from "@ai-oral-exam/conversation-contract";

import { toConversationStateDto } from "../src/worker/http/conversation-state-dto";
import {
  ConversationEventType,
  createConversation,
  value,
  type ConversationState,
} from "../src/domain/conversation-state-machine";
import { transitionRuntime } from "./transition-test-utils";

const at = value.unixMillis;

describe("sanitized conversation state DTO", () => {
  it("exposes transport and artifact status without internal artifact identifiers", () => {
    let state: ConversationState = createConversation(value.conversationSessionId("dto"), at(0));
    state = transitionRuntime(state, {
      type: ConversationEventType.StartRequested,
      eventId: "start",
      at: at(1),
      startDeadlineAt: at(1_000),
    });
    state = transitionRuntime(state, {
      type: ConversationEventType.TransportConnected,
      eventId: "connected",
      at: at(2),
      epoch: 1,
    });
    state = transitionRuntime(state, {
      type: ConversationEventType.RecordingStarted,
      eventId: "recording",
      at: at(3),
      recordingId: value.recordingId("secret-recording-id"),
    });
    state = transitionRuntime(state, {
      type: ConversationEventType.SessionStarted,
      eventId: "ready",
      at: at(4),
      epoch: 1,
      maximumEndAt: at(10_000),
    });
    state = transitionRuntime(state, {
      type: ConversationEventType.EndRequested,
      eventId: "end",
      at: at(5),
      reason: "done",
      endingDeadlineAt: at(500),
    });
    state = transitionRuntime(state, {
      type: ConversationEventType.RecordingUploadStarted,
      eventId: "upload",
      at: at(6),
      recordingId: value.recordingId("secret-recording-id"),
      expectedR2Key: value.r2ObjectKey("secret/object/key.webm"),
      artifactDeadlineAt: at(5_000),
    });

    const dto = toConversationStateDto(state);
    expect(conversationStateSchema.parse(dto)).toEqual(dto);
    expect(dto).toMatchObject({
      state: "ending",
      transport: { status: "connected", epoch: 1 },
      artifact: { status: "uploading" },
    });
    expect(JSON.stringify(dto)).not.toContain("secret-recording-id");
    expect(JSON.stringify(dto)).not.toContain("secret/object/key.webm");
  });
});
