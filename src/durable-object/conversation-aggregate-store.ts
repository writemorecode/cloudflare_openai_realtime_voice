import { deadlineEventForState, deadlineForState } from "../domain/conversation-deadlines";
import {
  ConversationEventType,
  IllegalTransitionError,
  TransitionGuardError,
  createConversation,
  transitionRuntime,
  type ConversationSessionId,
  type ConversationState,
  type UnixMillis,
} from "../domain/conversation-state-machine";
import {
  LIVEKIT_SHUTDOWN_MESSAGE_VERSION,
  type LiveKitShutdownMessage,
} from "../shared/livekit-shutdown";
import type {
  AlarmExecution,
  ApplyEventCommand,
  ApplyEventRejectionReason,
  ApplyEventResult,
  InitializeResult,
  TransitionReceipt,
} from "./conversation-session-contract";
import {
  LIVEKIT_SHUTDOWN_OUTBOX_KEY,
  SNAPSHOT_KEY,
  SNAPSHOT_SCHEMA_VERSION,
  decodeSnapshot,
  receiptKey,
  type PersistedSnapshot,
} from "./conversation-session-storage";

class AlarmTransitionRejectedError extends Error {
  constructor(reason: ApplyEventRejectionReason) {
    super(`Alarm transition was unexpectedly rejected: ${reason}`);
    this.name = "AlarmTransitionRejectedError";
  }
}

/** Persists and transitions the authoritative provider-neutral conversation aggregate. */
export class ConversationAggregateStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async initialize(
    objectName: string | undefined,
    sessionId: ConversationSessionId,
    at: UnixMillis,
  ): Promise<InitializeResult> {
    if (objectName !== sessionId) {
      return {
        status: "rejected",
        reason: "identity_mismatch",
        state: this.getState(),
      };
    }
    return this.storage.transaction(async (transaction) => {
      const current = await this.readState(transaction);
      if (current !== null) {
        await reconcileAlarm(transaction, current);
        return current.data.sessionId === sessionId
          ? ({ status: "existing", state: current } as const)
          : ({ status: "rejected", reason: "already_initialized", state: current } as const);
      }
      const state = createConversation(sessionId, at);
      await this.writeState(transaction, state);
      await reconcileAlarm(transaction, state);
      return { status: "initialized", state } as const;
    });
  }

  getState(): ConversationState | null {
    return decodeSnapshot(this.storage.kv.get<PersistedSnapshot>(SNAPSHOT_KEY));
  }

  applyEvent(command: ApplyEventCommand): Promise<ApplyEventResult> {
    return this.storage.transaction((transaction) =>
      this.applyEventInTransaction(transaction, command),
    );
  }

  applyDeadline(
    now: UnixMillis,
    observeContext: (context: Pick<AlarmExecution, "state" | "deadline" | "event">) => void,
  ): Promise<AlarmExecution> {
    return this.storage.transaction<AlarmExecution>(async (transaction) => {
      const state = await this.readState(transaction);
      if (state === null) {
        await transaction.deleteAlarm();
        return {
          outcome: "no_state",
          state: null,
          deadline: null,
          event: null,
          transition: null,
        };
      }
      const deadline = deadlineForState(state);
      const event = deadlineEventForState(state, now);
      observeContext({ state, deadline, event });
      if (deadline === null || event === null) {
        await transaction.deleteAlarm();
        return { outcome: "no_deadline", state, deadline: null, event: null, transition: null };
      }
      if (Number(now) < Number(deadline)) {
        await transaction.setAlarm(Number(deadline));
        return { outcome: "rescheduled_early", state, deadline, event, transition: null };
      }
      const transition = await this.applyEventInTransaction(transaction, {
        expectedRevision: state.revision,
        event,
      });
      if (transition.outcome === "rejected") {
        throw new AlarmTransitionRejectedError(transition.reason);
      }
      return {
        outcome: transition.outcome === "applied" ? "transition_applied" : "transition_duplicate",
        state,
        deadline,
        event,
        transition,
      };
    });
  }

  private async applyEventInTransaction(
    transaction: DurableObjectTransaction,
    command: ApplyEventCommand,
  ): Promise<ApplyEventResult> {
    const receipt = await transaction.get<TransitionReceipt>(receiptKey(command.event.eventId));
    const current = await this.readState(transaction);
    if (receipt !== undefined) {
      if (current === null) {
        throw new Error("Transition receipt exists without a conversation snapshot");
      }
      await reconcileAlarm(transaction, current);
      return { outcome: "duplicate", state: current, receipt };
    }
    if (current === null) return { outcome: "rejected", reason: "not_initialized", state: null };
    if (current.revision !== command.expectedRevision) {
      return { outcome: "rejected", reason: "revision_conflict", state: current };
    }
    let next: ConversationState;
    try {
      next = transitionRuntime(current, command.event);
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        return { outcome: "rejected", reason: "illegal_transition", state: current };
      }
      if (error instanceof TransitionGuardError) {
        return { outcome: "rejected", reason: "guard_failed", state: current };
      }
      throw error;
    }
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
    if (command.event.type === ConversationEventType.TimeLimitReached) {
      await transaction.put(LIVEKIT_SHUTDOWN_OUTBOX_KEY, {
        version: LIVEKIT_SHUTDOWN_MESSAGE_VERSION,
        conversationId: current.data.sessionId,
        triggerEventId: command.event.eventId,
      } satisfies LiveKitShutdownMessage);
    }
    await reconcileAlarm(transaction, next);
    return { outcome: "applied", state: next, receipt: appliedReceipt };
  }

  private async readState(
    transaction: DurableObjectTransaction,
  ): Promise<ConversationState | null> {
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
