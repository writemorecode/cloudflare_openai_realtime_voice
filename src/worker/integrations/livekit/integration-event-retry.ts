/** Applies revision-checked integration events with bounded, sequential retries. */
import type {
  ConversationEvent,
  ConversationState,
} from "../../../domain/conversation-state-machine";
import type {
  ApplyEventResult,
  ConversationSession,
} from "../../../durable-object/conversation-session";
import { err, ok, tryCatch, type Result } from "../../try-catch";

const MAX_ATTEMPTS = 3;

type RejectedApplyEventResult = Extract<ApplyEventResult, { outcome: "rejected" }>;

export interface IntegrationEventRetryErrors<E> {
  readonly rejected: (result: RejectedApplyEventResult) => E;
  readonly exhausted: () => E;
  readonly failed: (cause: unknown) => E;
}

export async function applyIntegrationEventWithRetry<E>(
  stub: DurableObjectStub<ConversationSession>,
  initial: ConversationState,
  event: ConversationEvent,
  errors: IntegrationEventRetryErrors<E>,
): Promise<Result<ConversationState, E>> {
  return applyAttempt(stub, initial, event, errors, MAX_ATTEMPTS);
}

async function applyAttempt<E>(
  stub: DurableObjectStub<ConversationSession>,
  state: ConversationState,
  event: ConversationEvent,
  errors: IntegrationEventRetryErrors<E>,
  attemptsRemaining: number,
): Promise<Result<ConversationState, E>> {
  const applied = await tryCatch(
    async (): Promise<ApplyEventResult> =>
      await stub.applyIntegrationEvent({
        expectedRevision: state.revision,
        event,
      }),
    errors.failed,
  );
  if (!applied.ok) return applied;

  const result = applied.value;
  if (result.outcome === "applied" || result.outcome === "duplicate") return ok(result.state);
  if (result.reason !== "revision_conflict" || result.state === null) {
    return err(errors.rejected(result));
  }
  if (attemptsRemaining === 1) return err(errors.exhausted());
  return applyAttempt(stub, result.state, event, errors, attemptsRemaining - 1);
}
