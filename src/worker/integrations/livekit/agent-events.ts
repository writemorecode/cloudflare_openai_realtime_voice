/** Authenticates and translates lifecycle observations emitted by the separately deployed agent. */
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
import type {
  AgentObservationKind,
  ConversationSession,
} from "../../../durable-object/conversation-session";
import { ApiError } from "../../http/api-errors";
import { authenticateBearer } from "../../http/api-security";
import { applyIntegrationEventWithRetry } from "./integration-event-retry";
import { reconcileCompositeReadiness } from "./readiness";

const MAX_AGENT_EVENT_BODY_BYTES = 16 * 1024;
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

type AgentEvent = z.infer<typeof agentEventSchema>;

export interface AgentEventResult {
  readonly conversationId: string;
  readonly state: ConversationState;
  readonly outcome: string;
}

export async function handleAgentEvent(request: Request, env: Env): Promise<AgentEventResult> {
  authenticateBearer(request, env.AGENT_CALLBACK_TOKEN);
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && Number(declaredLength) > MAX_AGENT_EVENT_BODY_BYTES) {
    throw new ApiError(413, "agent_event_too_large", "The agent event body is too large.");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_AGENT_EVENT_BODY_BYTES) {
    throw new ApiError(413, "agent_event_too_large", "The agent event body is too large.");
  }

  const parsed = parseJson(body);
  if (!parsed.success) {
    throw new ApiError(400, "invalid_agent_event", "The agent event is invalid.", {}, parsed.error);
  }
  const result = agentEventSchema.safeParse(parsed.value);
  if (!result.success) {
    throw new ApiError(400, "invalid_agent_event", "The agent event is invalid.");
  }
  const event = result.data;
  if (event.roomName !== `conversation-${event.conversationId}`) {
    throw new ApiError(400, "agent_event_room_mismatch", "The agent event room does not match.");
  }

  const stub = env.CONVERSATION_SESSIONS.getByName(event.conversationId);
  const initial = await stub.getState();
  if (initial === null) {
    throw new ApiError(404, "conversation_not_found", "Conversation not found.");
  }
  let state: ConversationState = initial;
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
    throw new ApiError(409, "stale_transport_epoch", "The agent event transport epoch is stale.");
  }

  const observation = await stub.recordAgentObservation({
    eventId: event.eventId,
    kind: event.type satisfies AgentObservationKind,
    roomName: event.roomName,
    transportEpoch: event.transportEpoch,
  });
  if (observation === "rejected") {
    throw new ApiError(409, "agent_event_correlation_failed", "The agent event did not correlate.");
  }
  if (observation === "duplicate") {
    return { conversationId: event.conversationId, state, outcome: "duplicate" };
  }

  const domainEvent = domainEventForAgentObservation(event, state);
  if (domainEvent !== null) {
    state = await applyIntegrationEvent(stub, state, domainEvent);
  }
  state = await reconcileCompositeReadiness(stub, Date.now());
  console.log(
    JSON.stringify({
      kind: "livekit_agent_event_processed",
      eventId: event.eventId,
      eventType: event.type,
      conversationId: event.conversationId,
      outcome: domainEvent === null ? "evidence_recorded" : "transition_applied",
      resultingState: state.tag,
      resultingRevision: state.revision,
    }),
  );
  return {
    conversationId: event.conversationId,
    state,
    outcome: domainEvent === null ? "evidence_recorded" : "transition_applied",
  };
}

function parseJson(
  body: string,
): Readonly<{ success: true; value: unknown }> | Readonly<{ success: false; error: unknown }> {
  try {
    return { success: true, value: JSON.parse(body) as unknown };
  } catch (error) {
    return { success: false, error };
  }
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

async function applyIntegrationEvent(
  stub: DurableObjectStub<ConversationSession>,
  initial: ConversationState,
  event: ConversationEvent,
): Promise<ConversationState> {
  return applyIntegrationEventWithRetry(stub, initial, event, {
    rejected: () => new ApiError(409, "agent_event_rejected", "The agent event was rejected."),
    exhausted: () =>
      new ApiError(409, "agent_event_conflict", "The agent event could not be applied."),
  });
}
