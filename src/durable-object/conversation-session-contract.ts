import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSessionId,
  ConversationState,
  ConversationStateTag,
  UnixMillis,
} from "../domain/conversation-state-machine";

export interface LiveKitProvisioningReady {
  readonly status: "ready";
  readonly roomName: string;
  readonly transportEpoch: number;
  readonly dispatchId: string;
  readonly egressId: string;
  readonly expectedR2Key: string;
}

export type BeginLiveKitShutdownResult =
  | Readonly<{ outcome: "owner"; provisioning: LiveKitProvisioningReady }>
  | Readonly<{ outcome: "stopped" }>
  | Readonly<{ outcome: "in_progress"; retryAt: number }>
  | Readonly<{ outcome: "rejected"; reason: "not_provisioned" | "conversation_active" }>;

export interface LiveKitTransportEvidence {
  readonly transportEpoch: number;
  readonly browserParticipantActive: boolean;
  readonly browserAudioPublished: boolean;
  readonly agentParticipantActive: boolean;
  readonly agentParticipantIdentity: string | null;
  readonly agentAudioPublished: boolean;
  readonly realtimeReady: boolean;
  readonly realtimeReadyEventId: string | null;
}

export type AgentObservationKind =
  | "realtime_ready"
  | "realtime_interrupted"
  | "realtime_recovered"
  | "realtime_failed"
  | "session_closed";

export type LiveKitMediaObservationKind =
  | "browser_participant_joined"
  | "browser_participant_left"
  | "browser_audio_published"
  | "browser_audio_unpublished"
  | "agent_participant_joined"
  | "agent_participant_left"
  | "agent_audio_published"
  | "agent_audio_unpublished";

export type BeginLiveKitProvisioningResult =
  | Readonly<{ outcome: "owner"; leaseId: string }>
  | Readonly<{ outcome: "ready"; provisioning: LiveKitProvisioningReady }>
  | Readonly<{ outcome: "in_progress"; retryAt: number }>
  | Readonly<{ outcome: "rejected"; reason: "not_starting" | "epoch_mismatch" }>;

export interface BeginLiveKitProvisioningCommand {
  readonly roomName: string;
  readonly transportEpoch: number;
  readonly leaseId: string;
  readonly leaseExpiresAt: number;
  readonly now: number;
}

export type CompleteLiveKitProvisioningCommand = LiveKitProvisioningReady & {
  readonly leaseId: string;
};

export interface BeginLiveKitShutdownCommand {
  readonly leaseId: string;
  readonly leaseExpiresAt: number;
  readonly now: number;
}

export interface CompleteLiveKitShutdownCommand {
  readonly leaseId: string;
  readonly stoppedAt: number;
}

export interface RecordAgentObservationCommand {
  readonly eventId: string;
  readonly kind: AgentObservationKind;
  readonly roomName: string;
  readonly transportEpoch: number;
}

export interface RecordLiveKitMediaObservationCommand {
  readonly eventId: string;
  readonly kind: LiveKitMediaObservationKind;
  readonly participantIdentity: string;
  readonly roomName: string;
  readonly transportEpoch: number;
}

export type RecordObservationResult =
  | Readonly<{ outcome: "recorded" }>
  | Readonly<{ outcome: "duplicate" }>
  | Readonly<{
      outcome: "rejected";
      reason: "not_provisioned" | "room_mismatch" | "epoch_mismatch";
    }>;

/** RPC-safe representation that avoids distributing a discriminated union across DO stubs. */
export interface RecordObservationRpcResult {
  readonly outcome: "recorded" | "duplicate" | "rejected";
  readonly reason: "not_provisioned" | "room_mismatch" | "epoch_mismatch" | null;
}

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
  | "failed";

export interface AlarmExecution {
  readonly outcome: Exclude<AlarmOutcome, "failed">;
  readonly state: ConversationState | null;
  readonly deadline: UnixMillis | null;
  readonly event: ConversationEvent | null;
  readonly transition: AcceptedApplyEventResult | null;
}
