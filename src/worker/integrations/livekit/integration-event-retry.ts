/** Applies revision-checked integration events with bounded, sequential retries. */
import { deserializeResult } from "@ai-oral-exam/conversation-contract";
import type {
  ConversationEvent,
  ConversationState,
} from "../../../domain/conversation-state-machine";
import type {
  ApplyEventResult,
  ConversationSession,
} from "../../../durable-object/conversation-session";
import type {
  AggregateStoreError,
  AggregateStoreResult,
} from "../../../durable-object/conversation-aggregate-store";
import { Result } from "better-result";

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
  const applied = await Result.tryPromise({
    try: async (): Promise<AggregateStoreResult<ApplyEventResult>> =>
      deserializeResult<ApplyEventResult, AggregateStoreError>(
        await stub.applyIntegrationEvent({
          expectedRevision: state.revision,
          event,
        }),
      ),
    catch: errors.failed,
  });
  if (!applied.isOk()) return applied;
  if (!applied.value.isOk()) return Result.err(errors.failed(applied.value.error));

  const result = applied.value.value;
  if (result.outcome === "applied" || result.outcome === "duplicate")
    return Result.ok(result.state);
  if (result.reason !== "revision_conflict" || result.state === null) {
    return Result.err(errors.rejected(result));
  }
  if (attemptsRemaining === 1) return Result.err(errors.exhausted());
  return applyAttempt(stub, result.state, event, errors, attemptsRemaining - 1);
}
