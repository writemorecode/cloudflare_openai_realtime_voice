/** Applies revision-checked trusted events with bounded, sequential retries. */
import { deserializeResult } from "@ai-oral-exam/conversation-contract";
import { Result } from "better-result";

import type { ConversationEvent, ConversationState } from "../../domain/conversation-state-machine";
import type {
  AggregateStoreError,
  AggregateStoreResult,
} from "../../durable-object/conversation-aggregate-store";
import type {
  ApplyEventResult,
  ConversationSession,
} from "../../durable-object/conversation-session";

const MAX_ATTEMPTS = 3;

export async function applyConversationEvent(
  stub: DurableObjectStub<ConversationSession>,
  initial: ConversationState,
  event: ConversationEvent,
): Promise<Result<ConversationState, Error>> {
  let state = initial;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- revision retries are intentionally sequential.
    const applied = await Result.tryPromise({
      try: async (): Promise<AggregateStoreResult<ApplyEventResult>> =>
        deserializeResult<ApplyEventResult, AggregateStoreError>(
          await stub.applyIntegrationEvent({ expectedRevision: state.revision, event }),
        ),
      catch: (cause) => new Error("Conversation transition failed.", { cause }),
    });
    if (!applied.isOk()) return applied;
    if (!applied.value.isOk()) {
      return Result.err(new Error("Conversation storage failed.", { cause: applied.value.error }));
    }
    const result = applied.value.value;
    if (result.outcome === "applied" || result.outcome === "duplicate") {
      return Result.ok(result.state);
    }
    if (result.reason !== "revision_conflict" || result.state === null) {
      return Result.err(new Error(`Conversation transition rejected: ${result.reason}.`));
    }
    state = result.state;
  }
  return Result.err(new Error("Conversation transition retries were exhausted."));
}
