import type {
  ConversationEventType,
  ConversationStateTag,
} from "../domain/conversation-state-machine";
import type {
  AlarmExecution,
  AlarmOutcome,
  ApplyEventCommand,
  ApplyEventRejectionReason,
  ApplyEventResult,
  TransitionTrigger,
} from "./conversation-session-contract";
import { observableError, type ObservableError } from "../shared/observable-error";

export interface TransitionTelemetryRecord {
  readonly kind: "conversation_transition";
  readonly level: "info" | "warn";
  readonly observedAt: number;
  readonly trigger: TransitionTrigger;
  readonly sessionId: string | null;
  readonly eventId: string;
  readonly eventType: ConversationEventType;
  readonly expectedRevision: number;
  readonly sourceState: ConversationStateTag | null;
  readonly targetState: ConversationStateTag | null;
  readonly sourceRevision: number | null;
  readonly targetRevision: number | null;
  readonly currentRevision: number | null;
  readonly outcome: ApplyEventResult["outcome"];
  readonly rejectionReason: ApplyEventRejectionReason | null;
}

export interface AlarmTelemetryRecord {
  readonly kind: "conversation_alarm";
  readonly level: "info" | "error";
  readonly observedAt: number;
  readonly sessionId: string | null;
  readonly state: ConversationStateTag | null;
  readonly revision: number | null;
  readonly deadline: number | null;
  readonly scheduledTime: number | null;
  readonly retryCount: number;
  readonly isRetry: boolean;
  readonly eventId: string | null;
  readonly eventType: ConversationEventType | null;
  readonly outcome: AlarmOutcome;
  readonly error: ObservableError | null;
}

export function emitTransitionTelemetry(
  command: ApplyEventCommand,
  result: ApplyEventResult,
  trigger: TransitionTrigger,
  fallbackSessionId: string | null,
): void {
  const receipt = result.outcome === "rejected" ? null : result.receipt;
  const record: TransitionTelemetryRecord = {
    kind: "conversation_transition",
    level: result.outcome === "rejected" ? "warn" : "info",
    observedAt: Date.now(),
    trigger,
    sessionId: result.state?.data.sessionId ?? fallbackSessionId,
    eventId: command.event.eventId,
    eventType: command.event.type,
    expectedRevision: command.expectedRevision,
    sourceState: receipt?.sourceState ?? result.state?.tag ?? null,
    targetState: receipt?.targetState ?? null,
    sourceRevision: receipt?.sourceRevision ?? result.state?.revision ?? null,
    targetRevision: receipt?.targetRevision ?? null,
    currentRevision: result.state?.revision ?? null,
    outcome: result.outcome,
    rejectionReason: result.outcome === "rejected" ? result.reason : null,
  };
  console.log(JSON.stringify(record));
}

export function emitAlarmTelemetry(
  execution: Omit<AlarmExecution, "outcome"> & { outcome: AlarmOutcome },
  alarmInfo: AlarmInvocationInfo | undefined,
  observedAt: number,
  error: unknown,
  fallbackSessionId: string | null,
): void {
  const record: AlarmTelemetryRecord = {
    kind: "conversation_alarm",
    level: execution.outcome === "failed" ? "error" : "info",
    observedAt,
    sessionId: execution.state?.data.sessionId ?? fallbackSessionId,
    state: execution.state?.tag ?? null,
    revision: execution.state?.revision ?? null,
    deadline: execution.deadline,
    scheduledTime: alarmInfo?.scheduledTime ?? null,
    retryCount: alarmInfo?.retryCount ?? 0,
    isRetry: alarmInfo?.isRetry ?? false,
    eventId: execution.event?.eventId ?? null,
    eventType: execution.event?.type ?? null,
    outcome: execution.outcome,
    error: error === null ? null : observableError(error),
  };
  const serialized = JSON.stringify(record);
  if (execution.outcome === "failed") console.error(serialized);
  else console.log(serialized);
}
