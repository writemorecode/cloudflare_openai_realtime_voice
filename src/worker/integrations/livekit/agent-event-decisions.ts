/** Pure decoding and state-dependent decisions for authenticated LiveKit Agent observations. */
import { z } from "zod";

import {
  ConversationEventType,
  ConversationStateTag,
  TransportStatus,
  value,
  type ConversationEvent,
  type ConversationState,
} from "../../../domain/conversation-state-machine";
import {
  ALARM_SHUTDOWN_GRACE_MS,
  TRANSPORT_RECOVERY_WINDOW_MS,
} from "../../../domain/conversation-deadlines";
import type { AgentObservationKind } from "../../../durable-object/conversation-session";
import { err, ok, type Result } from "@ai-oral-exam/result";

const AGENT_EVENT_ID_PATTERN = /^agent:[0-9a-f-]{36}:[1-9][0-9]*:[a-z-]+$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

const baseEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().regex(AGENT_EVENT_ID_PATTERN),
  conversationId: z.uuid(),
  roomName: z.string().startsWith("conversation-"),
  transportEpoch: z.int().positive(),
  occurredAt: z.iso.datetime({ offset: true }),
});

const agentEventSchema = z.discriminatedUnion("type", [
  baseEventSchema.extend({ type: z.literal("realtime_ready") }),
  baseEventSchema.extend({ type: z.literal("realtime_interrupted") }),
  baseEventSchema.extend({ type: z.literal("realtime_recovered") }),
  baseEventSchema.extend({
    type: z.literal("realtime_failed"),
    errorCode: z.string().regex(ERROR_CODE_PATTERN),
  }),
  baseEventSchema.extend({ type: z.literal("session_closed") }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;

export interface AgentObservationCommand {
  readonly eventId: string;
  readonly kind: AgentObservationKind;
  readonly roomName: string;
  readonly transportEpoch: number;
}

export interface AgentEventDecision {
  readonly observation: AgentObservationCommand;
  readonly domainEvent: ConversationEvent | null;
}

export interface AgentEventDecodeError {
  readonly code: "invalid_event" | "room_mismatch";
  readonly cause?: unknown;
}

export function decodeAgentEvent(body: string): Result<AgentEvent, AgentEventDecodeError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (cause) {
    return err({ code: "invalid_event", cause });
  }
  const result = agentEventSchema.safeParse(parsed);
  if (!result.success) return err({ code: "invalid_event" });
  const event = result.data;
  if (event.roomName !== `conversation-${event.conversationId}`) {
    return err({ code: "room_mismatch" });
  }
  return ok(event);
}

export function decideAgentEvent(
  event: AgentEvent,
  state: ConversationState,
): Result<AgentEventDecision, "stale_transport_epoch"> {
  const transport = state.data.transport;
  const advancesRecoveryEpoch =
    event.type === "realtime_recovered" &&
    state.tag === ConversationStateTag.Live &&
    transport.status === TransportStatus.Reconnecting &&
    event.transportEpoch === transport.epoch + 1;
  if (
    transport.status === TransportStatus.Idle ||
    (transport.epoch !== event.transportEpoch && !advancesRecoveryEpoch)
  ) {
    return err("stale_transport_epoch");
  }

  return ok({
    observation: {
      eventId: event.eventId,
      kind: event.type satisfies AgentObservationKind,
      roomName: event.roomName,
      transportEpoch: event.transportEpoch,
    },
    domainEvent: domainEventForAgentObservation(event, state),
  });
}

function domainEventForAgentObservation(
  event: AgentEvent,
  state: ConversationState,
): ConversationEvent | null {
  const at = value.unixMillis(Date.parse(event.occurredAt));
  switch (event.type) {
    case "realtime_ready":
    case "realtime_recovered":
      return null;
    case "realtime_interrupted":
      return state.tag === ConversationStateTag.Live &&
        state.data.transport.status === TransportStatus.Connected
        ? {
            type: ConversationEventType.TransportInterrupted,
            eventId: event.eventId,
            at,
            epoch: event.transportEpoch,
            errorCode: value.errorCode("transport.agent_realtime_interrupted"),
            recoveryDeadlineAt: value.unixMillis(Number(at) + TRANSPORT_RECOVERY_WINDOW_MS),
          }
        : null;
    case "realtime_failed":
      return state.tag === ConversationStateTag.Starting ||
        state.tag === ConversationStateTag.Live ||
        state.tag === ConversationStateTag.Ending
        ? {
            type: ConversationEventType.FatalTransportError,
            eventId: event.eventId,
            at,
            epoch: event.transportEpoch,
            errorCode: value.errorCode(event.errorCode),
            endingDeadlineAt: value.unixMillis(Number(at) + ALARM_SHUTDOWN_GRACE_MS),
          }
        : null;
    case "session_closed":
      return state.tag === ConversationStateTag.Starting ||
        state.tag === ConversationStateTag.Live ||
        state.tag === ConversationStateTag.Ending
        ? {
            type: ConversationEventType.SessionClosed,
            eventId: event.eventId,
            at,
            epoch: event.transportEpoch,
          }
        : null;
  }
}
