import { describe, expect, it } from "vitest";

import {
  ConversationEventType,
  createConversation,
  value,
  type LiveState,
  type StartingState,
} from "../src/domain/conversation-state-machine";
import { transition } from "./transition-test-utils";
import {
  decideAgentEvent,
  decodeAgentEvent,
  type AgentEvent,
} from "../src/worker/integrations/livekit/agent-event-decisions";

const CONVERSATION_ID = "12345678-1234-8234-9234-123456789abc";
const ROOM_NAME = `conversation-${CONVERSATION_ID}`;
const OCCURRED_AT = "2026-07-22T10:00:00.000Z";

function event(type: AgentEvent["type"], transportEpoch = 1): Record<string, unknown> {
  return {
    version: 1,
    type,
    eventId: `agent:${CONVERSATION_ID}:${transportEpoch}:${type.replaceAll("_", "-")}`,
    conversationId: CONVERSATION_ID,
    roomName: ROOM_NAME,
    transportEpoch,
    occurredAt: OCCURRED_AT,
    ...(type === "realtime_failed" ? { errorCode: "transport.agent_failed" } : {}),
  };
}

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
    eventId: "ready",
    at: value.unixMillis(5),
    epoch: 1,
    maximumEndAt: value.unixMillis(60_005),
  });
}

function decoded(type: AgentEvent["type"], transportEpoch = 1): AgentEvent {
  const result = decodeAgentEvent(JSON.stringify(event(type, transportEpoch)));
  if (!result.ok) throw new Error(`expected decoded event: ${result.error.code}`);
  return result.value;
}

describe("LiveKit agent event decisions", () => {
  it("decodes and correlates a valid observation", () => {
    expect(decodeAgentEvent(JSON.stringify(event("realtime_ready")))).toMatchObject({
      ok: true,
      value: {
        type: "realtime_ready",
        conversationId: CONVERSATION_ID,
        roomName: ROOM_NAME,
      },
    });
  });

  it("rejects malformed input and mismatched rooms", () => {
    expect(decodeAgentEvent("{")).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    expect(
      decodeAgentEvent(
        JSON.stringify({ ...event("realtime_ready"), roomName: "conversation-wrong" }),
      ),
    ).toEqual({ ok: false, error: { code: "room_mismatch" } });
  });

  it("records readiness without requesting a domain transition", () => {
    expect(decideAgentEvent(decoded("realtime_ready"), starting())).toMatchObject({
      ok: true,
      value: {
        observation: { kind: "realtime_ready", roomName: ROOM_NAME, transportEpoch: 1 },
        domainEvent: null,
      },
    });
  });

  it("plans an interruption for a connected live conversation", () => {
    expect(decideAgentEvent(decoded("realtime_interrupted"), live())).toMatchObject({
      ok: true,
      value: {
        domainEvent: {
          type: ConversationEventType.TransportInterrupted,
          epoch: 1,
          errorCode: "transport.agent_realtime_interrupted",
        },
      },
    });
  });

  it("allows only the next epoch for recovery", () => {
    const reconnecting = transition(live(), {
      type: ConversationEventType.TransportInterrupted,
      eventId: "interrupted",
      at: value.unixMillis(10),
      epoch: 1,
      errorCode: value.errorCode("transport.interrupted"),
      recoveryDeadlineAt: value.unixMillis(20_010),
    });

    expect(decideAgentEvent(decoded("realtime_recovered", 2), reconnecting)).toMatchObject({
      ok: true,
      value: { observation: { transportEpoch: 2 }, domainEvent: null },
    });
    expect(decideAgentEvent(decoded("realtime_recovered", 3), reconnecting)).toEqual({
      ok: false,
      error: "stale_transport_epoch",
    });
  });
});
