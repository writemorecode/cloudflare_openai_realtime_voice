/** Applies revision-checked integration events with bounded, sequential retries. */
import type {
  ConversationEvent,
  ConversationState,
} from "../../../domain/conversation-state-machine";
import type {
  ApplyEventResult,
  ConversationSession,
} from "../../../durable-object/conversation-session";

const MAX_ATTEMPTS = 3;

type RejectedApplyEventResult = Extract<ApplyEventResult, { outcome: "rejected" }>;

export interface IntegrationEventRetryErrors {
  readonly rejected: (result: RejectedApplyEventResult) => Error;
  readonly exhausted: () => Error;
}

export async function applyIntegrationEventWithRetry(
  stub: DurableObjectStub<ConversationSession>,
  initial: ConversationState,
  event: ConversationEvent,
  errors: IntegrationEventRetryErrors,
): Promise<ConversationState> {
  return applyAttempt(stub, initial, event, errors, MAX_ATTEMPTS);
}

async function applyAttempt(
  stub: DurableObjectStub<ConversationSession>,
  state: ConversationState,
  event: ConversationEvent,
  errors: IntegrationEventRetryErrors,
  attemptsRemaining: number,
): Promise<ConversationState> {
  const result = await stub.applyIntegrationEvent({
    expectedRevision: state.revision,
    event,
  });
  if (result.outcome === "applied" || result.outcome === "duplicate") return result.state;
  if (result.reason !== "revision_conflict" || result.state === null) {
    throw errors.rejected(result);
  }
  if (attemptsRemaining === 1) throw errors.exhausted();
  return applyAttempt(stub, result.state, event, errors, attemptsRemaining - 1);
}
