import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSessionId,
  ConversationState,
  ConversationStateTag,
  UnixMillis,
} from "../domain/conversation-state-machine";

export interface TransitionReceipt {
  readonly eventId: string;
  readonly eventType: ConversationEventType;
  readonly outcome: "applied";
  readonly sourceState: ConversationStateTag;
  readonly targetState: ConversationStateTag;
  readonly sourceRevision: number;
  readonly targetRevision: number;
  readonly appliedAt: UnixMillis;
}

export type InitializeResult =
  | Readonly<{ status: "initialized" | "existing"; state: ConversationState }>
  | Readonly<{
      status: "rejected";
      reason: "identity_mismatch" | "already_initialized";
      state: ConversationState | null;
    }>;

export interface InitializeCommand {
  readonly sessionId: ConversationSessionId;
  readonly at: UnixMillis;
}

export interface ApplyEventCommand {
  readonly expectedRevision: number;
  readonly event: ConversationEvent;
}

export type ApplyEventRejectionReason =
  | "not_initialized"
  | "revision_conflict"
  | "illegal_transition"
  | "guard_failed";

export type ApplyEventResult =
  | Readonly<{ outcome: "applied"; state: ConversationState; receipt: TransitionReceipt }>
  | Readonly<{ outcome: "duplicate"; state: ConversationState; receipt: TransitionReceipt }>
  | Readonly<{
      outcome: "rejected";
      reason: ApplyEventRejectionReason;
      state: ConversationState | null;
    }>;

export type AcceptedApplyEventResult = Exclude<ApplyEventResult, { outcome: "rejected" }>;
export type TransitionTrigger = "rpc" | "alarm";

export type AlarmOutcome =
  | "transition_applied"
  | "transition_duplicate"
  | "rescheduled_early"
  | "no_state"
  | "no_deadline"
  | "transition_rejected"
  | "failed";

export interface AlarmExecution {
  readonly outcome: Exclude<AlarmOutcome, "failed">;
  readonly state: ConversationState | null;
  readonly deadline: UnixMillis | null;
  readonly event: ConversationEvent | null;
  readonly transition: AcceptedApplyEventResult | null;
}
