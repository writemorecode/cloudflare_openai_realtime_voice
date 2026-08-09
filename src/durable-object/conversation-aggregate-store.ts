import { deadlineEventForState, deadlineForState } from "../domain/conversation-deadlines";
import {
  createConversation,
  transitionRuntime,
  type ConversationSessionId,
  type ConversationState,
  type UnixMillis,
} from "../domain/conversation-state-machine";
import { Result } from "better-result";
import type {
  AlarmExecution,
  ApplyEventCommand,
  ApplyEventResult,
  InitializeResult,
  TransitionReceipt,
} from "./conversation-session-contract";
import {
  SNAPSHOT_KEY,
  SNAPSHOT_SCHEMA_VERSION,
  decodeSnapshot,
  receiptKey,
  type PersistedSnapshot,
  type UnsupportedSnapshotVersionError,
} from "./conversation-session-storage";

export type AggregateStoreError =
  | UnsupportedSnapshotVersionError
  | Readonly<{ kind: "inconsistent_storage" }>;

export type AggregateStoreResult<T> = Result<T, AggregateStoreError>;

/** Persists and transitions the authoritative provider-neutral conversation aggregate. */
export class ConversationAggregateStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async initialize(
    objectName: string | undefined,
    sessionId: ConversationSessionId,
    at: UnixMillis,
  ): Promise<AggregateStoreResult<InitializeResult>> {
    if (objectName !== sessionId) {
      const current = this.getState();
      if (!current.isOk()) return current;
      return Result.ok({
        status: "rejected",
        reason: "identity_mismatch",
        state: current.value,
      });
    }
    return this.storage.transaction(async (transaction) => {
      const current = await this.readState(transaction);
      if (!current.isOk()) return current;
      if (current.value !== null) {
        await reconcileAlarm(transaction, current.value);
        return Result.ok(
          current.value.data.sessionId === sessionId
            ? ({ status: "existing", state: current.value } as const)
            : ({
                status: "rejected",
                reason: "already_initialized",
                state: current.value,
              } as const),
        );
      }
      const state = createConversation(sessionId, at);
      await this.writeState(transaction, state);
      await reconcileAlarm(transaction, state);
      return Result.ok({ status: "initialized", state } as const);
    });
  }

  getState(): AggregateStoreResult<ConversationState | null> {
    return decodeSnapshot(this.storage.kv.get<PersistedSnapshot>(SNAPSHOT_KEY));
  }

  applyEvent(command: ApplyEventCommand): Promise<AggregateStoreResult<ApplyEventResult>> {
    return this.storage.transaction((transaction) =>
      this.applyEventInTransaction(transaction, command),
    );
  }

  applyDeadline(
    now: UnixMillis,
    observeContext: (context: Pick<AlarmExecution, "state" | "deadline" | "event">) => void,
  ): Promise<AggregateStoreResult<AlarmExecution>> {
    return this.storage.transaction<AggregateStoreResult<AlarmExecution>>(async (transaction) => {
      const decoded = await this.readState(transaction);
      if (!decoded.isOk()) return decoded;
      const state = decoded.value;
      if (state === null) {
        await transaction.deleteAlarm();
        return Result.ok({
          outcome: "no_state",
          state: null,
          deadline: null,
          event: null,
          transition: null,
        });
      }
      const deadline = deadlineForState(state);
      const event = deadlineEventForState(state, now);
      observeContext({ state, deadline, event });
      if (deadline === null || event === null) {
        await transaction.deleteAlarm();
        return Result.ok({
          outcome: "no_deadline",
          state,
          deadline: null,
          event: null,
          transition: null,
        });
      }
      if (Number(now) < Number(deadline)) {
        await transaction.setAlarm(Number(deadline));
        return Result.ok({
          outcome: "rescheduled_early",
          state,
          deadline,
          event,
          transition: null,
        });
      }
      const applied = await this.applyEventInTransaction(transaction, {
        expectedRevision: state.revision,
        event,
      });
      if (!applied.isOk()) return applied;
      const transition = applied.value;
      if (transition.outcome === "rejected") {
        return Result.ok({
          outcome: "transition_rejected",
          state,
          deadline,
          event,
          transition: null,
        });
      }
      return Result.ok({
        outcome: transition.outcome === "applied" ? "transition_applied" : "transition_duplicate",
        state,
        deadline,
        event,
        transition,
      });
    });
  }

  private async applyEventInTransaction(
    transaction: DurableObjectTransaction,
    command: ApplyEventCommand,
  ): Promise<AggregateStoreResult<ApplyEventResult>> {
    const receipt = await transaction.get<TransitionReceipt>(receiptKey(command.event.eventId));
    const decoded = await this.readState(transaction);
    if (!decoded.isOk()) return decoded;
    const current = decoded.value;
    if (receipt !== undefined) {
      if (current === null) {
        return Result.err({ kind: "inconsistent_storage" });
      }
      await reconcileAlarm(transaction, current);
      return Result.ok({ outcome: "duplicate", state: current, receipt });
    }
    if (current === null) {
      return Result.ok({ outcome: "rejected", reason: "not_initialized", state: null });
    }
    if (current.revision !== command.expectedRevision) {
      return Result.ok({ outcome: "rejected", reason: "revision_conflict", state: current });
    }
    const transitioned = transitionRuntime(current, command.event);
    if (!transitioned.isOk()) {
      return Result.ok({
        outcome: "rejected",
        reason:
          transitioned.error.kind === "illegal_transition" ? "illegal_transition" : "guard_failed",
        state: current,
      });
    }
    const next: ConversationState = transitioned.value;
    const appliedReceipt: TransitionReceipt = {
      eventId: command.event.eventId,
      eventType: command.event.type,
      outcome: "applied",
      sourceState: current.tag,
      targetState: next.tag,
      sourceRevision: current.revision,
      targetRevision: next.revision,
      appliedAt: command.event.at,
    };
    await this.writeState(transaction, next);
    await transaction.put(receiptKey(command.event.eventId), appliedReceipt);
    await reconcileAlarm(transaction, next);
    return Result.ok({ outcome: "applied", state: next, receipt: appliedReceipt });
  }

  private async readState(
    transaction: DurableObjectTransaction,
  ): Promise<AggregateStoreResult<ConversationState | null>> {
    return decodeSnapshot(await transaction.get<PersistedSnapshot>(SNAPSHOT_KEY));
  }

  private async writeState(
    transaction: DurableObjectTransaction,
    state: ConversationState,
  ): Promise<void> {
    await transaction.put(SNAPSHOT_KEY, {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      state,
    } satisfies PersistedSnapshot);
  }
}

async function reconcileAlarm(
  transaction: DurableObjectTransaction,
  state: ConversationState,
): Promise<void> {
  const deadline = deadlineForState(state);
  if (deadline === null) {
    await transaction.deleteAlarm();
    return;
  }
  await transaction.setAlarm(Number(deadline));
}
