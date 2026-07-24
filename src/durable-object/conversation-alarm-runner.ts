import { value } from "../domain/conversation-state-machine";
import type { LiveKitShutdownMessage } from "../shared/livekit-shutdown";
import { err, ok, tryCatch, type Result } from "@ai-oral-exam/result";
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
    const operation = await tryCatch(
      async (): Promise<Result<AlarmExecution, AlarmRunnerError>> => {
        const initialFlush = await this.flushShutdownOutbox();
        if (!initialFlush.ok) return initialFlush;
        const stored = await this.aggregate.applyDeadline(now, (observed) => {
          context = observed;
        });
        if (!stored.ok) {
          return stored.error.kind === "unsupported_snapshot_version"
            ? err({
                kind: "snapshot_decode_failed",
                schemaVersion: stored.error.schemaVersion,
              })
            : err({ kind: "inconsistent_storage" });
        }
        if (stored.value.outcome === "transition_rejected") {
          return err({ kind: "alarm_transition_rejected" });
        }
        return ok(stored.value);
      },
      (cause): AlarmRunnerError => ({ kind: "runtime_failure", cause }),
    );
    const execution = operation.ok ? operation.value : operation;
    if (!execution.ok) {
      emitAlarmTelemetry(
        { outcome: "failed", ...context, transition: null },
        alarmInfo,
        now,
        execution.error,
        this.sessionId,
      );
      await tryCatch(
        () => this.storage.setAlarm(Date.now() + ALARM_RETRY_DELAY_MS),
        (cause): AlarmRunnerError => ({ kind: "runtime_failure", cause }),
      );
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
    if (!finalFlush.ok) {
      emitAlarmTelemetry(
        { outcome: "failed", ...context, transition: null },
        alarmInfo,
        now,
        finalFlush.error,
        this.sessionId,
      );
      await tryCatch(
        () => this.storage.setAlarm(Date.now() + ALARM_RETRY_DELAY_MS),
        (cause): AlarmRunnerError => ({ kind: "runtime_failure", cause }),
      );
      return finalFlush;
    }
    emitAlarmTelemetry(execution.value, alarmInfo, now, null, this.sessionId);
    return ok(undefined);
  }

  async flushShutdownOutbox(): Promise<Result<void, AlarmRunnerError>> {
    return tryCatch(
      async () => {
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
      (cause): AlarmRunnerError => ({ kind: "runtime_failure", cause }),
    );
  }
}
