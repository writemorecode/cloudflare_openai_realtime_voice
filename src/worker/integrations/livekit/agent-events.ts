/** Authenticates and executes lifecycle observations emitted by the separately deployed agent. */
import { deserializeResult } from "@ai-oral-exam/conversation-contract";
import type {
  ConversationEvent,
  ConversationState,
} from "../../../domain/conversation-state-machine";
import type { ConversationSession } from "../../../durable-object/conversation-session";
import type {
  AggregateStoreError,
  AggregateStoreResult,
} from "../../../durable-object/conversation-aggregate-store";
import { ApiError } from "../../http/api-errors";
import { authenticateBearer } from "../../http/api-security";
import type { AgentEventDependencies } from "../../ports/foundation";
import { Result } from "better-result";
import { applyIntegrationEventWithRetry } from "./integration-event-retry";
import { reconcileCompositeReadiness } from "./readiness";
import { decideAgentEvent, decodeAgentEvent } from "./agent-event-decisions";

const MAX_AGENT_EVENT_BODY_BYTES = 16 * 1024;

export interface AgentEventResult {
  readonly conversationId: string;
  readonly state: ConversationState;
  readonly outcome: string;
}

export async function handleAgentEvent(
  request: Request,
  env: Env,
  dependencies: AgentEventDependencies,
): Promise<Result<AgentEventResult, ApiError>> {
  const authenticated = authenticateBearer(request, env.AGENT_CALLBACK_TOKEN);
  if (!authenticated.isOk()) return authenticated;

  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return Result.err(
      new ApiError(415, "unsupported_media_type", "Content-Type must be application/json."),
    );
  }
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && Number(declaredLength) > MAX_AGENT_EVENT_BODY_BYTES) {
    return Result.err(
      new ApiError(413, "agent_event_too_large", "The agent event body is too large."),
    );
  }
  const body = await Result.tryPromise({
    try: () => request.text(),
    catch: agentOperationFailed,
  });
  if (!body.isOk()) return body;
  if (new TextEncoder().encode(body.value).byteLength > MAX_AGENT_EVENT_BODY_BYTES) {
    return Result.err(
      new ApiError(413, "agent_event_too_large", "The agent event body is too large."),
    );
  }

  const decoded = decodeAgentEvent(body.value);
  if (!decoded.isOk()) return Result.err(agentDecodeError(decoded.error));
  const event = decoded.value;

  const stub = dependencies.conversations.get(event.conversationId);
  const initial = await Result.tryPromise({
    try: async (): Promise<AggregateStoreResult<ConversationState | null>> =>
      deserializeResult<ConversationState | null, AggregateStoreError>(await stub.getState()),
    catch: agentOperationFailed,
  });
  if (!initial.isOk()) return initial;
  if (!initial.value.isOk()) return Result.err(agentOperationFailed(initial.value.error));
  if (initial.value.value === null) {
    return Result.err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  let state: ConversationState = initial.value.value;
  const decision = decideAgentEvent(event, state);
  if (!decision.isOk()) {
    return Result.err(
      new ApiError(409, "stale_transport_epoch", "The agent event transport epoch is stale."),
    );
  }

  const observation = await Result.tryPromise({
    try: () => stub.recordAgentObservation(decision.value.observation),
    catch: agentOperationFailed,
  });
  if (!observation.isOk()) return observation;
  if (observation.value.outcome === "rejected") {
    if (observation.value.reason === null) {
      return Result.err(
        agentOperationFailed(new Error("Rejected observation omitted its reason.")),
      );
    }
    return Result.err(agentCorrelationError(observation.value.reason));
  }
  if (observation.value.outcome === "duplicate") {
    return Result.ok({ conversationId: event.conversationId, state, outcome: "duplicate" });
  }

  const domainEvent = decision.value.domainEvent;
  if (domainEvent !== null) {
    const applied = await applyIntegrationEvent(stub, state, domainEvent);
    if (!applied.isOk()) return applied;
    state = applied.value;
  }
  const readiness = await reconcileCompositeReadiness(stub, dependencies.clock.now());
  if (!readiness.isOk()) return readiness;
  state = readiness.value;
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
  return Result.ok({
    conversationId: event.conversationId,
    state,
    outcome: domainEvent === null ? "evidence_recorded" : "transition_applied",
  });
}

function agentDecodeError(error: {
  readonly code: "invalid_event" | "room_mismatch";
  readonly cause?: unknown;
}): ApiError {
  return error.code === "room_mismatch"
    ? new ApiError(400, "agent_event_room_mismatch", "The agent event room does not match.")
    : new ApiError(400, "invalid_agent_event", "The agent event is invalid.", {}, error.cause);
}

async function applyIntegrationEvent(
  stub: DurableObjectStub<ConversationSession>,
  initial: ConversationState,
  event: ConversationEvent,
): Promise<Result<ConversationState, ApiError>> {
  return applyIntegrationEventWithRetry(stub, initial, event, {
    rejected: () => new ApiError(409, "agent_event_rejected", "The agent event was rejected."),
    exhausted: () =>
      new ApiError(409, "agent_event_conflict", "The agent event could not be applied."),
    failed: (cause) =>
      new ApiError(
        500,
        "agent_event_apply_failed",
        "The agent event could not be applied.",
        {},
        cause,
      ),
  });
}

function agentOperationFailed(cause: unknown): ApiError {
  return new ApiError(
    500,
    "agent_event_operation_failed",
    "The agent event could not be processed.",
    {},
    cause,
  );
}

function agentCorrelationError(
  reason: "not_provisioned" | "room_mismatch" | "epoch_mismatch",
): ApiError {
  return reason === "not_provisioned"
    ? new ApiError(
        503,
        "agent_event_provisioning_pending",
        "Agent event correlation is not ready.",
        { "Retry-After": "1" },
      )
    : new ApiError(409, "agent_event_correlation_failed", "The agent event did not correlate.");
}
