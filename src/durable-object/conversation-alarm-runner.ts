import { value } from "../domain/conversation-state-machine";
import type { LiveKitShutdownMessage } from "../shared/livekit-shutdown";
import { ConversationAggregateStore } from "./conversation-aggregate-store";
import { emitAlarmTelemetry, emitTransitionTelemetry } from "./conversation-telemetry";
import type { AlarmExecution } from "./conversation-session-contract";
import { LIVEKIT_SHUTDOWN_OUTBOX_KEY } from "./conversation-session-storage";

/** Executes the single conversation deadline and delivers its transactional shutdown outbox. */
export class ConversationAlarmRunner {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly shutdownQueue: Queue<LiveKitShutdownMessage>,
    private readonly aggregate: ConversationAggregateStore,
    private readonly sessionId: string | null,
  ) {}

  async run(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const now = value.unixMillis(Date.now());
    let context: Pick<AlarmExecution, "state" | "deadline" | "event"> = {
      state: null,
      deadline: null,
      event: null,
    };
    try {
      await this.flushShutdownOutbox();
      const execution = await this.aggregate.applyDeadline(now, (observed) => {
        context = observed;
      });
      if (execution.transition !== null && execution.event !== null) {
        emitTransitionTelemetry(
          { expectedRevision: execution.transition.receipt.sourceRevision, event: execution.event },
          execution.transition,
          "alarm",
          this.sessionId,
        );
      }
      await this.flushShutdownOutbox();
      emitAlarmTelemetry(execution, alarmInfo, now, null, this.sessionId);
    } catch (error) {
      emitAlarmTelemetry(
        { outcome: "failed", ...context, transition: null },
        alarmInfo,
        now,
        error,
        this.sessionId,
      );
      throw error;
    }
  }

  async flushShutdownOutbox(): Promise<void> {
    const pending = await this.storage.get<LiveKitShutdownMessage>(LIVEKIT_SHUTDOWN_OUTBOX_KEY);
    if (pending === undefined) return;

    await this.shutdownQueue.send(pending, { contentType: "json" });
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<LiveKitShutdownMessage>(LIVEKIT_SHUTDOWN_OUTBOX_KEY);
      if (current?.triggerEventId === pending.triggerEventId) {
        await transaction.delete(LIVEKIT_SHUTDOWN_OUTBOX_KEY);
      }
    });
  }
}
