import { value } from "../domain/conversation-state-machine";
import type { LiveKitShutdownMessage } from "../shared/livekit-shutdown";
import { Result } from "better-result";
import { ConversationAggregateStore } from "./conversation-aggregate-store";
import { emitAlarmTelemetry, emitTransitionTelemetry } from "./conversation-telemetry";
import type { AlarmExecution } from "./conversation-session-contract";
import { LIVEKIT_SHUTDOWN_OUTBOX_KEY } from "./conversation-session-storage";

const ALARM_RETRY_DELAY_MS = 5_000;

export type AlarmRunnerError =
  | Readonly<{ kind: "snapshot_decode_failed"; schemaVersion: unknown }>
  | Readonly<{ kind: "inconsistent_storage" }>
  | Readonly<{ kind: "alarm_transition_rejected" }>
  | Readonly<{ kind: "runtime_failure"; cause: unknown }>;

/** Executes the single conversation deadline and delivers its transactional shutdown outbox. */
export class ConversationAlarmRunner {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly shutdownQueue: Queue<LiveKitShutdownMessage>,
    private readonly aggregate: ConversationAggregateStore,
    private readonly sessionId: string | null,
  ) {}

  async run(alarmInfo?: AlarmInvocationInfo): Promise<Result<void, AlarmRunnerError>> {
    const now = value.unixMillis(Date.now());
    let context: Pick<AlarmExecution, "state" | "deadline" | "event"> = {
      state: null,
      deadline: null,
      event: null,
    };
    const operation = await Result.tryPromise({
      try: async (): Promise<Result<AlarmExecution, AlarmRunnerError>> => {
        const initialFlush = await this.flushShutdownOutbox();
        if (!initialFlush.isOk()) return initialFlush;
        const stored = await this.aggregate.applyDeadline(now, (observed) => {
          context = observed;
        });
        if (!stored.isOk()) {
          return stored.error.kind === "unsupported_snapshot_version"
            ? Result.err({
                kind: "snapshot_decode_failed",
                schemaVersion: stored.error.schemaVersion,
              })
            : Result.err({ kind: "inconsistent_storage" });
        }
        if (stored.value.outcome === "transition_rejected") {
          return Result.err({ kind: "alarm_transition_rejected" });
        }
        return Result.ok(stored.value);
      },
      catch: (cause): AlarmRunnerError => ({ kind: "runtime_failure", cause }),
    });
    const execution = operation.isOk() ? operation.value : operation;
    if (!execution.isOk()) {
      emitAlarmTelemetry(
        { outcome: "failed", ...context, transition: null },
        alarmInfo,
        now,
        execution.error,
        this.sessionId,
      );
      await Result.tryPromise({
        try: () => this.storage.setAlarm(Date.now() + ALARM_RETRY_DELAY_MS),
        catch: (cause): AlarmRunnerError => ({ kind: "runtime_failure", cause }),
      });
      return execution;
    }

    if (execution.value.transition !== null && execution.value.event !== null) {
      emitTransitionTelemetry(
        {
          expectedRevision: execution.value.transition.receipt.sourceRevision,
          event: execution.value.event,
        },
        execution.value.transition,
        "alarm",
        this.sessionId,
      );
    }
    const finalFlush = await this.flushShutdownOutbox();
    if (!finalFlush.isOk()) {
      emitAlarmTelemetry(
        { outcome: "failed", ...context, transition: null },
        alarmInfo,
        now,
        finalFlush.error,
        this.sessionId,
      );
      await Result.tryPromise({
        try: () => this.storage.setAlarm(Date.now() + ALARM_RETRY_DELAY_MS),
        catch: (cause): AlarmRunnerError => ({ kind: "runtime_failure", cause }),
      });
      return finalFlush;
    }
    emitAlarmTelemetry(execution.value, alarmInfo, now, null, this.sessionId);
    return Result.ok(undefined);
  }

  async flushShutdownOutbox(): Promise<Result<void, AlarmRunnerError>> {
    return Result.tryPromise({
      try: async () => {
        const pending = await this.storage.get<LiveKitShutdownMessage>(LIVEKIT_SHUTDOWN_OUTBOX_KEY);
        if (pending === undefined) return;

        await this.shutdownQueue.send(pending, { contentType: "json" });
        await this.storage.transaction(async (transaction) => {
          const current = await transaction.get<LiveKitShutdownMessage>(
            LIVEKIT_SHUTDOWN_OUTBOX_KEY,
          );
          if (current?.triggerEventId === pending.triggerEventId) {
            await transaction.delete(LIVEKIT_SHUTDOWN_OUTBOX_KEY);
          }
        });
      },
      catch: (cause): AlarmRunnerError => ({ kind: "runtime_failure", cause }),
    });
  }
}
