/** Executes provider-neutral transitions selected by the pure composite-readiness policy. */
import type {
  ConversationEvent,
  ConversationState,
} from "../../../domain/conversation-state-machine";
import type {
  ConversationSession,
  LiveKitTransportEvidence,
} from "../../../durable-object/conversation-session";
import { ApiError } from "../../http/api-errors";
import { err, ok, tryCatch, type Result } from "@ai-oral-exam/result";
import { applyIntegrationEventWithRetry } from "./integration-event-retry";
import { nextReadinessEvent } from "./readiness-decisions";

export async function reconcileCompositeReadiness(
  stub: DurableObjectStub<ConversationSession>,
  observedAt: number,
): Promise<Result<ConversationState, ApiError>> {
  const required = await requiredState(stub);
  if (!required.ok) return required;
  const evidenceResult = await tryCatch(
    () => stub.getLiveKitTransportEvidence(),
    readinessOperationFailed,
  );
  if (!evidenceResult.ok) return evidenceResult;
  return applyReadinessTransitions(stub, required.value, evidenceResult.value, observedAt);
}

async function applyReadinessTransitions(
  stub: DurableObjectStub<ConversationSession>,
  state: ConversationState,
  evidence: LiveKitTransportEvidence | null,
  observedAt: number,
): Promise<Result<ConversationState, ApiError>> {
  const event = nextReadinessEvent(state, evidence, observedAt);
  if (event === null) return ok(state);
  const applied = await applyIntegrationEvent(stub, state, event);
  return applied.ok
    ? applyReadinessTransitions(stub, applied.value, evidence, observedAt)
    : applied;
}

async function requiredState(
  stub: DurableObjectStub<ConversationSession>,
): Promise<Result<ConversationState, ApiError>> {
  const state = await tryCatch(
    async (): Promise<ConversationState | null> => await stub.getState(),
    readinessOperationFailed,
  );
  if (!state.ok) return state;
  if (state.value === null) {
    return err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  return ok(state.value);
}

async function applyIntegrationEvent(
  stub: DurableObjectStub<ConversationSession>,
  initial: ConversationState,
  event: ConversationEvent,
): Promise<Result<ConversationState, ApiError>> {
  return applyIntegrationEventWithRetry(stub, initial, event, {
    rejected: () =>
      new ApiError(409, "readiness_transition_rejected", "Readiness could not be applied."),
    exhausted: () =>
      new ApiError(409, "readiness_transition_conflict", "Readiness could not be applied."),
    failed: readinessOperationFailed,
  });
}

function readinessOperationFailed(cause: unknown): ApiError {
  return new ApiError(
    500,
    "readiness_operation_failed",
    "Readiness could not be determined.",
    {},
    cause,
  );
}
