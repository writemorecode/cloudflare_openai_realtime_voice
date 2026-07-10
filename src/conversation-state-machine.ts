const opaqueBrand: unique symbol = Symbol("opaqueBrand");

type Opaque<Name extends string, Value> = Value & {
  readonly [opaqueBrand]: Name;
};

function opaque<Name extends string, Value>(input: Value): Opaque<Name, Value> {
  return input as Opaque<Name, Value>;
}

export type ConversationSessionId = Opaque<"ConversationSessionId", string>;
export type RealtimeKitMeetingId = Opaque<"RealtimeKitMeetingId", string>;
export type RealtimeKitSessionId = Opaque<"RealtimeKitSessionId", string>;
export type RealtimeKitParticipantId = Opaque<"RealtimeKitParticipantId", string>;
export type RecordingRequestId = Opaque<"RecordingRequestId", string>;
export type RecordingId = Opaque<"RecordingId", string>;
export type OpenAiCallId = Opaque<"OpenAiCallId", string>;
export type WorkflowId = Opaque<"WorkflowId", string>;
export type R2ObjectKey = Opaque<"R2ObjectKey", string>;
export type R2Etag = Opaque<"R2Etag", string>;
export type ErrorCode = Opaque<"ErrorCode", string>;
export type UnixMillis = Opaque<"UnixMillis", number>;

/** Identity constructors for validated values entering the FSM boundary. */
export const value = {
  conversationSessionId: (input: string): ConversationSessionId =>
    opaque<"ConversationSessionId", string>(input),
  errorCode: (input: string): ErrorCode => opaque<"ErrorCode", string>(input),
  openAiCallId: (input: string): OpenAiCallId => opaque<"OpenAiCallId", string>(input),
  participantId: (input: string): RealtimeKitParticipantId =>
    opaque<"RealtimeKitParticipantId", string>(input),
  r2Etag: (input: string): R2Etag => opaque<"R2Etag", string>(input),
  r2ObjectKey: (input: string): R2ObjectKey => opaque<"R2ObjectKey", string>(input),
  realtimeKitMeetingId: (input: string): RealtimeKitMeetingId =>
    opaque<"RealtimeKitMeetingId", string>(input),
  realtimeKitSessionId: (input: string): RealtimeKitSessionId =>
    opaque<"RealtimeKitSessionId", string>(input),
  recordingId: (input: string): RecordingId => opaque<"RecordingId", string>(input),
  recordingRequestId: (input: string): RecordingRequestId =>
    opaque<"RecordingRequestId", string>(input),
  unixMillis: (input: number): UnixMillis => opaque<"UnixMillis", number>(input),
  workflowId: (input: string): WorkflowId => opaque<"WorkflowId", string>(input),
};

export enum ConversationStateTag {
  Created = "created",
  Provisioning = "provisioning",
  AwaitingBridge = "awaiting_bridge",
  StartingRecording = "starting_recording",
  Live = "live",
  Recovering = "recovering",
  Stopping = "stopping",
  AwaitingRecordingArtifact = "awaiting_recording_artifact",
  PostProcessing = "post_processing",
  ActionRequired = "action_required",
  Completed = "completed",
  Cancelled = "cancelled",
  Failed = "failed",
}

export enum ConversationEventType {
  StartRequested = "start_requested",
  ResourcesProvisioned = "resources_provisioned",
  RetryableProvisioningError = "retryable_provisioning_error",
  ProvisioningAttemptsExhausted = "provisioning_attempts_exhausted",
  BridgeProgressed = "bridge_progressed",
  BridgeReady = "bridge_ready",
  ReadinessDeadlineExceeded = "readiness_deadline_exceeded",
  RecordingConfirmed = "recording_confirmed",
  RecordingFailed = "recording_failed",
  RecordingStartDeadlineExceeded = "recording_start_deadline_exceeded",
  RecoverableConnectionLost = "recoverable_connection_lost",
  ConnectionsRestored = "connections_restored",
  RecoveryAttemptFailed = "recovery_attempt_failed",
  RecoveryDeadlineExceeded = "recovery_deadline_exceeded",
  EndRequested = "end_requested",
  TimeLimitReached = "time_limit_reached",
  FatalTransportError = "fatal_transport_error",
  RecordingUploadStarted = "recording_upload_started",
  ShutdownCompleted = "shutdown_completed",
  ShutdownDeadlineExceeded = "shutdown_deadline_exceeded",
  RecordingArtifactVerified = "recording_artifact_verified",
  RecordingErrored = "recording_errored",
  ArtifactDeadlineExceeded = "artifact_deadline_exceeded",
  WorkflowCompleted = "workflow_completed",
  WorkflowAttemptsExhausted = "workflow_attempts_exhausted",
  RetryApproved = "retry_approved",
  AbandonRequested = "abandon_requested",
}

export enum StopReason {
  UserRequested = "user_requested",
  TimeLimitReached = "time_limit_reached",
  RecordingFailed = "recording_failed",
  ConnectionRecoveryExhausted = "connection_recovery_exhausted",
  ReadinessDeadlineExceeded = "readiness_deadline_exceeded",
  FatalTransportError = "fatal_transport_error",
}

export enum RecoverableConnection {
  BrowserBridge = "browser_bridge",
  OpenAiWebRtc = "openai_webrtc",
  OpenAiSideband = "openai_sideband",
  RealtimeKitHuman = "realtimekit_human",
  RealtimeKitAgent = "realtimekit_agent",
}

export enum FailureStage {
  Provisioning = "provisioning",
  BridgeReadiness = "bridge_readiness",
  Recording = "recording",
  Recovery = "recovery",
  Shutdown = "shutdown",
  RecordingArtifact = "recording_artifact",
  PostProcessing = "post_processing",
}

export interface BridgeReadiness {
  readonly humanJoined: boolean;
  readonly agentJoined: boolean;
  readonly openAiConnected: boolean;
  readonly sidebandConnected: boolean;
  readonly agentTrackPublished: boolean;
}

export interface ProvisionedResources {
  readonly meetingId: RealtimeKitMeetingId;
  readonly humanParticipantId: RealtimeKitParticipantId;
  readonly agentParticipantId: RealtimeKitParticipantId;
  readonly bridgeGeneration: number;
}

export interface ConnectedResources extends ProvisionedResources {
  readonly realtimeKitSessionId: RealtimeKitSessionId;
  readonly openAiCallId: OpenAiCallId;
  readonly recordingRequestId: RecordingRequestId;
}

export interface LiveResources extends ConnectedResources {
  readonly recordingId: RecordingId;
}

type StateVariant<K extends ConversationStateTag, D> = Readonly<{
  tag: K;
  revision: number;
  enteredAt: UnixMillis;
  updatedAt: UnixMillis;
  data: Readonly<D & { sessionId: ConversationSessionId }>;
}>;

export type CreatedState = StateVariant<ConversationStateTag.Created, object>;

export type ProvisioningState = StateVariant<
  ConversationStateTag.Provisioning,
  {
    attempt: number;
    deadlineAt: UnixMillis;
    lastErrorCode: ErrorCode | null;
  }
>;

export type AwaitingBridgeState = StateVariant<
  ConversationStateTag.AwaitingBridge,
  {
    resources: ProvisionedResources;
    readiness: BridgeReadiness;
    deadlineAt: UnixMillis;
  }
>;

export type StartingRecordingState = StateVariant<
  ConversationStateTag.StartingRecording,
  {
    resources: ConnectedResources;
    deadlineAt: UnixMillis;
  }
>;

export type LiveState = StateVariant<
  ConversationStateTag.Live,
  {
    resources: LiveResources;
    startedAt: UnixMillis;
    maximumEndAt: UnixMillis;
  }
>;

export type RecoveringState = StateVariant<
  ConversationStateTag.Recovering,
  {
    live: LiveState["data"];
    connection: RecoverableConnection;
    attempt: number;
    deadlineAt: UnixMillis;
    lastErrorCode: ErrorCode | null;
  }
>;

export type RecordingDisposition =
  | Readonly<{ kind: "not_started" }>
  | Readonly<{ kind: "errored"; errorCode: ErrorCode; recordingId: RecordingId | null }>
  | Readonly<{ kind: "stop_required"; recordingId: RecordingId }>;

export type StoppingState = StateVariant<
  ConversationStateTag.Stopping,
  {
    resources: ProvisionedResources | ConnectedResources | LiveResources | null;
    reason: StopReason;
    recording: RecordingDisposition;
    deadlineAt: UnixMillis;
  }
>;

export type AwaitingRecordingArtifactState = StateVariant<
  ConversationStateTag.AwaitingRecordingArtifact,
  {
    recordingId: RecordingId;
    expectedR2Key: R2ObjectKey;
    terminationReason: StopReason;
    stoppedAt: UnixMillis;
    deadlineAt: UnixMillis;
  }
>;

export type PostProcessingState = StateVariant<
  ConversationStateTag.PostProcessing,
  {
    recordingId: RecordingId;
    r2Key: R2ObjectKey;
    r2Etag: R2Etag;
    workflowId: WorkflowId;
    attempt: number;
    terminationReason: StopReason;
  }
>;

export type ActionRequiredState = StateVariant<
  ConversationStateTag.ActionRequired,
  {
    recordingId: RecordingId;
    r2Key: R2ObjectKey;
    r2Etag: R2Etag;
    workflowId: WorkflowId;
    attempt: number;
    failedStep: string;
    errorCode: ErrorCode;
    terminationReason: StopReason;
  }
>;

export type CompletedState = StateVariant<
  ConversationStateTag.Completed,
  {
    recordingId: RecordingId;
    r2Key: R2ObjectKey;
    r2Etag: R2Etag;
    workflowId: WorkflowId;
    completedAt: UnixMillis;
    terminationReason: StopReason;
  }
>;

export type CancelledState = StateVariant<
  ConversationStateTag.Cancelled,
  {
    cancelledAt: UnixMillis;
    reason: string;
  }
>;

export type FailedState = StateVariant<
  ConversationStateTag.Failed,
  {
    failedAt: UnixMillis;
    stage: FailureStage;
    errorCode: ErrorCode;
    recordingId: RecordingId | null;
  }
>;

export interface ConversationStateByTag {
  [ConversationStateTag.Created]: CreatedState;
  [ConversationStateTag.Provisioning]: ProvisioningState;
  [ConversationStateTag.AwaitingBridge]: AwaitingBridgeState;
  [ConversationStateTag.StartingRecording]: StartingRecordingState;
  [ConversationStateTag.Live]: LiveState;
  [ConversationStateTag.Recovering]: RecoveringState;
  [ConversationStateTag.Stopping]: StoppingState;
  [ConversationStateTag.AwaitingRecordingArtifact]: AwaitingRecordingArtifactState;
  [ConversationStateTag.PostProcessing]: PostProcessingState;
  [ConversationStateTag.ActionRequired]: ActionRequiredState;
  [ConversationStateTag.Completed]: CompletedState;
  [ConversationStateTag.Cancelled]: CancelledState;
  [ConversationStateTag.Failed]: FailedState;
}

export type ConversationState = ConversationStateByTag[ConversationStateTag];

type EventVariant<K extends ConversationEventType, D = object> = Readonly<{
  type: K;
  eventId: string;
  at: UnixMillis;
}> &
  Readonly<D>;

export type StartRequestedEvent = EventVariant<
  ConversationEventType.StartRequested,
  { provisioningDeadlineAt: UnixMillis }
>;
export type ResourcesProvisionedEvent = EventVariant<
  ConversationEventType.ResourcesProvisioned,
  { resources: ProvisionedResources; readinessDeadlineAt: UnixMillis }
>;
export type RetryableProvisioningErrorEvent = EventVariant<
  ConversationEventType.RetryableProvisioningError,
  { errorCode: ErrorCode; nextDeadlineAt: UnixMillis }
>;
export type ProvisioningAttemptsExhaustedEvent = EventVariant<
  ConversationEventType.ProvisioningAttemptsExhausted,
  { errorCode: ErrorCode }
>;
export type BridgeProgressedEvent = EventVariant<
  ConversationEventType.BridgeProgressed,
  { readiness: BridgeReadiness; bridgeGeneration: number }
>;
export type BridgeReadyEvent = EventVariant<
  ConversationEventType.BridgeReady,
  {
    bridgeGeneration: number;
    realtimeKitSessionId: RealtimeKitSessionId;
    openAiCallId: OpenAiCallId;
    recordingRequestId: RecordingRequestId;
    recordingStartDeadlineAt: UnixMillis;
  }
>;
export type ReadinessDeadlineExceededEvent = EventVariant<
  ConversationEventType.ReadinessDeadlineExceeded,
  { shutdownDeadlineAt: UnixMillis }
>;
export type RecordingConfirmedEvent = EventVariant<
  ConversationEventType.RecordingConfirmed,
  { recordingId: RecordingId; maximumEndAt: UnixMillis }
>;
export type RecordingFailedEvent = EventVariant<
  ConversationEventType.RecordingFailed,
  { recordingId: RecordingId | null; errorCode: ErrorCode; shutdownDeadlineAt: UnixMillis }
>;
export type RecordingStartDeadlineExceededEvent = EventVariant<
  ConversationEventType.RecordingStartDeadlineExceeded,
  { errorCode: ErrorCode; shutdownDeadlineAt: UnixMillis }
>;
export type RecoverableConnectionLostEvent = EventVariant<
  ConversationEventType.RecoverableConnectionLost,
  { connection: RecoverableConnection; recoveryDeadlineAt: UnixMillis }
>;
export type ConnectionsRestoredEvent = EventVariant<ConversationEventType.ConnectionsRestored>;
export type RecoveryAttemptFailedEvent = EventVariant<
  ConversationEventType.RecoveryAttemptFailed,
  { errorCode: ErrorCode; nextDeadlineAt: UnixMillis }
>;
export type RecoveryDeadlineExceededEvent = EventVariant<
  ConversationEventType.RecoveryDeadlineExceeded,
  { errorCode: ErrorCode; shutdownDeadlineAt: UnixMillis }
>;
export type EndRequestedEvent = EventVariant<
  ConversationEventType.EndRequested,
  { reason: string; shutdownDeadlineAt: UnixMillis }
>;
export type TimeLimitReachedEvent = EventVariant<
  ConversationEventType.TimeLimitReached,
  { shutdownDeadlineAt: UnixMillis }
>;
export type FatalTransportErrorEvent = EventVariant<
  ConversationEventType.FatalTransportError,
  { errorCode: ErrorCode; shutdownDeadlineAt: UnixMillis }
>;
export type RecordingUploadStartedEvent = EventVariant<
  ConversationEventType.RecordingUploadStarted,
  { recordingId: RecordingId; expectedR2Key: R2ObjectKey; artifactDeadlineAt: UnixMillis }
>;
export type ShutdownCompletedEvent = EventVariant<
  ConversationEventType.ShutdownCompleted,
  { cancellationReason: string; failureCode: ErrorCode }
>;
export type ShutdownDeadlineExceededEvent = EventVariant<
  ConversationEventType.ShutdownDeadlineExceeded,
  { errorCode: ErrorCode }
>;
export type RecordingArtifactVerifiedEvent = EventVariant<
  ConversationEventType.RecordingArtifactVerified,
  { recordingId: RecordingId; r2Key: R2ObjectKey; r2Etag: R2Etag; workflowId: WorkflowId }
>;
export type RecordingErroredEvent = EventVariant<
  ConversationEventType.RecordingErrored,
  { recordingId: RecordingId; errorCode: ErrorCode }
>;
export type ArtifactDeadlineExceededEvent = EventVariant<
  ConversationEventType.ArtifactDeadlineExceeded,
  { errorCode: ErrorCode }
>;
export type WorkflowCompletedEvent = EventVariant<ConversationEventType.WorkflowCompleted>;
export type WorkflowAttemptsExhaustedEvent = EventVariant<
  ConversationEventType.WorkflowAttemptsExhausted,
  { failedStep: string; errorCode: ErrorCode }
>;
export type RetryApprovedEvent = EventVariant<
  ConversationEventType.RetryApproved,
  { workflowId: WorkflowId }
>;
export type AbandonRequestedEvent = EventVariant<
  ConversationEventType.AbandonRequested,
  { errorCode: ErrorCode }
>;

export type ConversationEvent =
  | StartRequestedEvent
  | ResourcesProvisionedEvent
  | RetryableProvisioningErrorEvent
  | ProvisioningAttemptsExhaustedEvent
  | BridgeProgressedEvent
  | BridgeReadyEvent
  | ReadinessDeadlineExceededEvent
  | RecordingConfirmedEvent
  | RecordingFailedEvent
  | RecordingStartDeadlineExceededEvent
  | RecoverableConnectionLostEvent
  | ConnectionsRestoredEvent
  | RecoveryAttemptFailedEvent
  | RecoveryDeadlineExceededEvent
  | EndRequestedEvent
  | TimeLimitReachedEvent
  | FatalTransportErrorEvent
  | RecordingUploadStartedEvent
  | ShutdownCompletedEvent
  | ShutdownDeadlineExceededEvent
  | RecordingArtifactVerifiedEvent
  | RecordingErroredEvent
  | ArtifactDeadlineExceededEvent
  | WorkflowCompletedEvent
  | WorkflowAttemptsExhaustedEvent
  | RetryApprovedEvent
  | AbandonRequestedEvent;

interface TransitionTargets {
  [ConversationStateTag.Created]: {
    [ConversationEventType.StartRequested]: ProvisioningState;
    [ConversationEventType.EndRequested]: CancelledState;
  };
  [ConversationStateTag.Provisioning]: {
    [ConversationEventType.ResourcesProvisioned]: AwaitingBridgeState;
    [ConversationEventType.RetryableProvisioningError]: ProvisioningState;
    [ConversationEventType.ProvisioningAttemptsExhausted]: FailedState;
    [ConversationEventType.EndRequested]: StoppingState;
  };
  [ConversationStateTag.AwaitingBridge]: {
    [ConversationEventType.BridgeProgressed]: AwaitingBridgeState;
    [ConversationEventType.BridgeReady]: StartingRecordingState;
    [ConversationEventType.ReadinessDeadlineExceeded]: StoppingState;
    [ConversationEventType.FatalTransportError]: StoppingState;
    [ConversationEventType.EndRequested]: StoppingState;
  };
  [ConversationStateTag.StartingRecording]: {
    [ConversationEventType.RecordingConfirmed]: LiveState;
    [ConversationEventType.RecordingFailed]: StoppingState;
    [ConversationEventType.RecordingStartDeadlineExceeded]: StoppingState;
    [ConversationEventType.EndRequested]: StoppingState;
  };
  [ConversationStateTag.Live]: {
    [ConversationEventType.RecoverableConnectionLost]: RecoveringState;
    [ConversationEventType.RecordingFailed]: StoppingState;
    [ConversationEventType.EndRequested]: StoppingState;
    [ConversationEventType.TimeLimitReached]: StoppingState;
    [ConversationEventType.FatalTransportError]: StoppingState;
  };
  [ConversationStateTag.Recovering]: {
    [ConversationEventType.ConnectionsRestored]: LiveState;
    [ConversationEventType.RecoveryAttemptFailed]: RecoveringState;
    [ConversationEventType.RecoveryDeadlineExceeded]: StoppingState;
    [ConversationEventType.RecordingFailed]: StoppingState;
    [ConversationEventType.EndRequested]: StoppingState;
  };
  [ConversationStateTag.Stopping]: {
    [ConversationEventType.RecordingUploadStarted]: AwaitingRecordingArtifactState;
    [ConversationEventType.ShutdownCompleted]: CancelledState | FailedState;
    [ConversationEventType.ShutdownDeadlineExceeded]: FailedState;
  };
  [ConversationStateTag.AwaitingRecordingArtifact]: {
    [ConversationEventType.RecordingArtifactVerified]: PostProcessingState;
    [ConversationEventType.RecordingErrored]: FailedState;
    [ConversationEventType.ArtifactDeadlineExceeded]: FailedState;
  };
  [ConversationStateTag.PostProcessing]: {
    [ConversationEventType.WorkflowCompleted]: CompletedState;
    [ConversationEventType.WorkflowAttemptsExhausted]: ActionRequiredState;
  };
  [ConversationStateTag.ActionRequired]: {
    [ConversationEventType.RetryApproved]: PostProcessingState;
    [ConversationEventType.AbandonRequested]: FailedState;
  };
}

export type TransitionableStateTag = keyof TransitionTargets;
export type TransitionableState = ConversationStateByTag[TransitionableStateTag];
export type AllowedEventType<K extends TransitionableStateTag> = K extends TransitionableStateTag
  ? keyof TransitionTargets[K] & ConversationEventType
  : never;
export type AllowedEvent<K extends TransitionableStateTag> = Extract<
  ConversationEvent,
  { type: AllowedEventType<K> }
>;
export type NextState<
  K extends TransitionableStateTag,
  E extends AllowedEventType<K>,
> = K extends TransitionableStateTag
  ? E extends keyof TransitionTargets[K]
    ? TransitionTargets[K][E]
    : never
  : never;

type IsUnion<T, Whole = T> = T extends unknown ? ([Whole] extends [T] ? false : true) : never;

type RequireSingleState<S extends TransitionableState> = true extends IsUnion<S["tag"]> ? never : S;

export class IllegalTransitionError extends Error {
  readonly state: ConversationStateTag;
  readonly event: ConversationEventType;

  constructor(state: ConversationStateTag, event: ConversationEventType) {
    super(`Event ${event} is illegal from state ${state}`);
    this.name = "IllegalTransitionError";
    this.state = state;
    this.event = event;
  }
}

export class TransitionGuardError extends Error {
  readonly state: ConversationStateTag;
  readonly event: ConversationEventType;
  readonly reason: string;

  constructor(state: ConversationStateTag, event: ConversationEventType, reason: string) {
    super(`Transition ${state} + ${event} failed guard: ${reason}`);
    this.name = "TransitionGuardError";
    this.state = state;
    this.event = event;
    this.reason = reason;
  }
}

export function createConversation(sessionId: ConversationSessionId, at: UnixMillis): CreatedState {
  return {
    tag: ConversationStateTag.Created,
    revision: 0,
    enteredAt: at,
    updatedAt: at,
    data: { sessionId },
  };
}

/**
 * Typed callers can only pass events legal for the exact source state. Values
 * parsed from storage or the network must still be validated before calling.
 */
export function transition<
  const S extends TransitionableState,
  const E extends AllowedEvent<NoInfer<S["tag"]>>,
>(state: RequireSingleState<S>, event: E): NextState<S["tag"], E["type"]>;
export function transition(state: ConversationState, event: ConversationEvent): ConversationState {
  switch (state.tag) {
    case ConversationStateTag.Created:
      return transitionCreated(state, event);
    case ConversationStateTag.Provisioning:
      return transitionProvisioning(state, event);
    case ConversationStateTag.AwaitingBridge:
      return transitionAwaitingBridge(state, event);
    case ConversationStateTag.StartingRecording:
      return transitionStartingRecording(state, event);
    case ConversationStateTag.Live:
      return transitionLive(state, event);
    case ConversationStateTag.Recovering:
      return transitionRecovering(state, event);
    case ConversationStateTag.Stopping:
      return transitionStopping(state, event);
    case ConversationStateTag.AwaitingRecordingArtifact:
      return transitionAwaitingArtifact(state, event);
    case ConversationStateTag.PostProcessing:
      return transitionPostProcessing(state, event);
    case ConversationStateTag.ActionRequired:
      return transitionActionRequired(state, event);
    case ConversationStateTag.Completed:
    case ConversationStateTag.Cancelled:
    case ConversationStateTag.Failed:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function nextState<K extends ConversationStateTag, D extends { sessionId: ConversationSessionId }>(
  previous: ConversationState,
  tag: K,
  at: UnixMillis,
  data: D,
): StateVariant<K, Omit<D, "sessionId">> {
  return {
    tag,
    revision: previous.revision + 1,
    enteredAt: at,
    updatedAt: at,
    data,
  };
}

function reviseState<K extends ConversationStateTag, D>(
  previous: StateVariant<K, D>,
  at: UnixMillis,
  data: NoInfer<StateVariant<K, D>["data"]>,
): StateVariant<K, D> {
  return {
    tag: previous.tag,
    revision: previous.revision + 1,
    enteredAt: previous.enteredAt,
    updatedAt: at,
    data,
  };
}

function fail(
  state: ConversationState,
  event: { at: UnixMillis },
  stage: FailureStage,
  errorCode: ErrorCode,
  recordingId: RecordingId | null,
): FailedState {
  return nextState(state, ConversationStateTag.Failed, event.at, {
    sessionId: state.data.sessionId,
    failedAt: event.at,
    stage,
    errorCode,
    recordingId,
  });
}

function stopping(
  state: ConversationState,
  event: { at: UnixMillis },
  resources: StoppingState["data"]["resources"],
  reason: StopReason,
  recording: RecordingDisposition,
  deadlineAt: UnixMillis,
): StoppingState {
  return nextState(state, ConversationStateTag.Stopping, event.at, {
    sessionId: state.data.sessionId,
    resources,
    reason,
    recording,
    deadlineAt,
  });
}

function transitionCreated(state: CreatedState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case ConversationEventType.StartRequested:
      return nextState(state, ConversationStateTag.Provisioning, event.at, {
        sessionId: state.data.sessionId,
        attempt: 1,
        deadlineAt: event.provisioningDeadlineAt,
        lastErrorCode: null,
      });
    case ConversationEventType.EndRequested:
      return nextState(state, ConversationStateTag.Cancelled, event.at, {
        sessionId: state.data.sessionId,
        cancelledAt: event.at,
        reason: event.reason,
      });
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function transitionProvisioning(
  state: ProvisioningState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case ConversationEventType.ResourcesProvisioned:
      return nextState(state, ConversationStateTag.AwaitingBridge, event.at, {
        sessionId: state.data.sessionId,
        resources: event.resources,
        readiness: emptyReadiness(),
        deadlineAt: event.readinessDeadlineAt,
      });
    case ConversationEventType.RetryableProvisioningError:
      return reviseState(state, event.at, {
        sessionId: state.data.sessionId,
        attempt: state.data.attempt + 1,
        deadlineAt: event.nextDeadlineAt,
        lastErrorCode: event.errorCode,
      });
    case ConversationEventType.ProvisioningAttemptsExhausted:
      return fail(state, event, FailureStage.Provisioning, event.errorCode, null);
    case ConversationEventType.EndRequested:
      return stopping(
        state,
        event,
        null,
        StopReason.UserRequested,
        { kind: "not_started" },
        event.shutdownDeadlineAt,
      );
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function transitionAwaitingBridge(
  state: AwaitingBridgeState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case ConversationEventType.BridgeProgressed:
      requireBridgeGeneration(state, event.bridgeGeneration, event.type);
      return reviseState(state, event.at, {
        ...state.data,
        readiness: event.readiness,
      });
    case ConversationEventType.BridgeReady:
      requireBridgeGeneration(state, event.bridgeGeneration, event.type);
      requireAllReady(state, event.type);
      return nextState(state, ConversationStateTag.StartingRecording, event.at, {
        sessionId: state.data.sessionId,
        resources: {
          ...state.data.resources,
          realtimeKitSessionId: event.realtimeKitSessionId,
          openAiCallId: event.openAiCallId,
          recordingRequestId: event.recordingRequestId,
        },
        deadlineAt: event.recordingStartDeadlineAt,
      });
    case ConversationEventType.ReadinessDeadlineExceeded:
      return stopping(
        state,
        event,
        state.data.resources,
        StopReason.ReadinessDeadlineExceeded,
        { kind: "not_started" },
        event.shutdownDeadlineAt,
      );
    case ConversationEventType.FatalTransportError:
      return stopping(
        state,
        event,
        state.data.resources,
        StopReason.FatalTransportError,
        { kind: "not_started" },
        event.shutdownDeadlineAt,
      );
    case ConversationEventType.EndRequested:
      return stopping(
        state,
        event,
        state.data.resources,
        StopReason.UserRequested,
        { kind: "not_started" },
        event.shutdownDeadlineAt,
      );
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function transitionStartingRecording(
  state: StartingRecordingState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case ConversationEventType.RecordingConfirmed:
      return nextState(state, ConversationStateTag.Live, event.at, {
        sessionId: state.data.sessionId,
        resources: { ...state.data.resources, recordingId: event.recordingId },
        startedAt: event.at,
        maximumEndAt: event.maximumEndAt,
      });
    case ConversationEventType.RecordingFailed:
      return stopping(
        state,
        event,
        state.data.resources,
        StopReason.RecordingFailed,
        { kind: "errored", errorCode: event.errorCode, recordingId: event.recordingId },
        event.shutdownDeadlineAt,
      );
    case ConversationEventType.RecordingStartDeadlineExceeded:
      return stopping(
        state,
        event,
        state.data.resources,
        StopReason.RecordingFailed,
        { kind: "errored", errorCode: event.errorCode, recordingId: null },
        event.shutdownDeadlineAt,
      );
    case ConversationEventType.EndRequested:
      return stopping(
        state,
        event,
        state.data.resources,
        StopReason.UserRequested,
        { kind: "not_started" },
        event.shutdownDeadlineAt,
      );
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function transitionLive(state: LiveState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case ConversationEventType.RecoverableConnectionLost:
      return nextState(state, ConversationStateTag.Recovering, event.at, {
        sessionId: state.data.sessionId,
        live: state.data,
        connection: event.connection,
        attempt: 1,
        deadlineAt: event.recoveryDeadlineAt,
        lastErrorCode: null,
      });
    case ConversationEventType.RecordingFailed:
      requireRecordingId(state.data.resources.recordingId, event.recordingId, state, event.type);
      return stopping(
        state,
        event,
        state.data.resources,
        StopReason.RecordingFailed,
        {
          kind: "errored",
          errorCode: event.errorCode,
          recordingId: state.data.resources.recordingId,
        },
        event.shutdownDeadlineAt,
      );
    case ConversationEventType.EndRequested:
      return stopping(
        state,
        event,
        state.data.resources,
        StopReason.UserRequested,
        { kind: "stop_required", recordingId: state.data.resources.recordingId },
        event.shutdownDeadlineAt,
      );
    case ConversationEventType.TimeLimitReached:
      return stopping(
        state,
        event,
        state.data.resources,
        StopReason.TimeLimitReached,
        { kind: "stop_required", recordingId: state.data.resources.recordingId },
        event.shutdownDeadlineAt,
      );
    case ConversationEventType.FatalTransportError:
      return stopping(
        state,
        event,
        state.data.resources,
        StopReason.FatalTransportError,
        { kind: "stop_required", recordingId: state.data.resources.recordingId },
        event.shutdownDeadlineAt,
      );
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function transitionRecovering(state: RecoveringState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case ConversationEventType.ConnectionsRestored:
      return nextState(state, ConversationStateTag.Live, event.at, state.data.live);
    case ConversationEventType.RecoveryAttemptFailed:
      return reviseState(state, event.at, {
        ...state.data,
        attempt: state.data.attempt + 1,
        deadlineAt: event.nextDeadlineAt,
        lastErrorCode: event.errorCode,
      });
    case ConversationEventType.RecoveryDeadlineExceeded:
      return stopping(
        state,
        event,
        state.data.live.resources,
        StopReason.ConnectionRecoveryExhausted,
        { kind: "stop_required", recordingId: state.data.live.resources.recordingId },
        event.shutdownDeadlineAt,
      );
    case ConversationEventType.RecordingFailed:
      requireRecordingId(
        state.data.live.resources.recordingId,
        event.recordingId,
        state,
        event.type,
      );
      return stopping(
        state,
        event,
        state.data.live.resources,
        StopReason.RecordingFailed,
        {
          kind: "errored",
          errorCode: event.errorCode,
          recordingId: state.data.live.resources.recordingId,
        },
        event.shutdownDeadlineAt,
      );
    case ConversationEventType.EndRequested:
      return stopping(
        state,
        event,
        state.data.live.resources,
        StopReason.UserRequested,
        { kind: "stop_required", recordingId: state.data.live.resources.recordingId },
        event.shutdownDeadlineAt,
      );
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function transitionStopping(state: StoppingState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case ConversationEventType.RecordingUploadStarted:
      if (state.data.recording.kind !== "stop_required") {
        throw new TransitionGuardError(state.tag, event.type, "no valid recording to upload");
      }
      requireRecordingId(state.data.recording.recordingId, event.recordingId, state, event.type);
      return nextState(state, ConversationStateTag.AwaitingRecordingArtifact, event.at, {
        sessionId: state.data.sessionId,
        recordingId: event.recordingId,
        expectedR2Key: event.expectedR2Key,
        terminationReason: state.data.reason,
        stoppedAt: event.at,
        deadlineAt: event.artifactDeadlineAt,
      });
    case ConversationEventType.ShutdownCompleted:
      if (
        state.data.recording.kind === "not_started" &&
        state.data.reason === StopReason.UserRequested
      ) {
        return nextState(state, ConversationStateTag.Cancelled, event.at, {
          sessionId: state.data.sessionId,
          cancelledAt: event.at,
          reason: event.cancellationReason,
        });
      }
      return fail(
        state,
        event,
        failureStageForStopReason(state.data.reason),
        state.data.recording.kind === "errored"
          ? state.data.recording.errorCode
          : event.failureCode,
        state.data.recording.kind === "not_started" ? null : state.data.recording.recordingId,
      );
    case ConversationEventType.ShutdownDeadlineExceeded:
      return fail(
        state,
        event,
        FailureStage.Shutdown,
        event.errorCode,
        state.data.recording.kind === "not_started" ? null : state.data.recording.recordingId,
      );
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function transitionAwaitingArtifact(
  state: AwaitingRecordingArtifactState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case ConversationEventType.RecordingArtifactVerified:
      requireRecordingId(state.data.recordingId, event.recordingId, state, event.type);
      if (state.data.expectedR2Key !== event.r2Key) {
        throw new TransitionGuardError(state.tag, event.type, "R2 object key does not match");
      }
      return nextState(state, ConversationStateTag.PostProcessing, event.at, {
        sessionId: state.data.sessionId,
        recordingId: event.recordingId,
        r2Key: event.r2Key,
        r2Etag: event.r2Etag,
        workflowId: event.workflowId,
        attempt: 1,
        terminationReason: state.data.terminationReason,
      });
    case ConversationEventType.RecordingErrored:
      requireRecordingId(state.data.recordingId, event.recordingId, state, event.type);
      return fail(state, event, FailureStage.RecordingArtifact, event.errorCode, event.recordingId);
    case ConversationEventType.ArtifactDeadlineExceeded:
      return fail(
        state,
        event,
        FailureStage.RecordingArtifact,
        event.errorCode,
        state.data.recordingId,
      );
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function transitionPostProcessing(
  state: PostProcessingState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case ConversationEventType.WorkflowCompleted:
      return nextState(state, ConversationStateTag.Completed, event.at, {
        sessionId: state.data.sessionId,
        recordingId: state.data.recordingId,
        r2Key: state.data.r2Key,
        r2Etag: state.data.r2Etag,
        workflowId: state.data.workflowId,
        completedAt: event.at,
        terminationReason: state.data.terminationReason,
      });
    case ConversationEventType.WorkflowAttemptsExhausted:
      return nextState(state, ConversationStateTag.ActionRequired, event.at, {
        ...state.data,
        failedStep: event.failedStep,
        errorCode: event.errorCode,
      });
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function transitionActionRequired(
  state: ActionRequiredState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case ConversationEventType.RetryApproved:
      return nextState(state, ConversationStateTag.PostProcessing, event.at, {
        sessionId: state.data.sessionId,
        recordingId: state.data.recordingId,
        r2Key: state.data.r2Key,
        r2Etag: state.data.r2Etag,
        workflowId: event.workflowId,
        attempt: state.data.attempt + 1,
        terminationReason: state.data.terminationReason,
      });
    case ConversationEventType.AbandonRequested:
      return fail(
        state,
        event,
        FailureStage.PostProcessing,
        event.errorCode,
        state.data.recordingId,
      );
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function emptyReadiness(): BridgeReadiness {
  return {
    humanJoined: false,
    agentJoined: false,
    openAiConnected: false,
    sidebandConnected: false,
    agentTrackPublished: false,
  };
}

function requireAllReady(state: AwaitingBridgeState, event: ConversationEventType): void {
  const readiness = state.data.readiness;
  if (
    !readiness.humanJoined ||
    !readiness.agentJoined ||
    !readiness.openAiConnected ||
    !readiness.sidebandConnected ||
    !readiness.agentTrackPublished
  ) {
    throw new TransitionGuardError(state.tag, event, "bridge is not fully ready");
  }
}

function requireBridgeGeneration(
  state: AwaitingBridgeState,
  actual: number,
  event: ConversationEventType,
): void {
  if (state.data.resources.bridgeGeneration !== actual) {
    throw new TransitionGuardError(state.tag, event, "stale bridge generation");
  }
}

function requireRecordingId(
  expected: RecordingId,
  actual: RecordingId | null,
  state: ConversationState,
  event: ConversationEventType,
): void {
  if (expected !== actual) {
    throw new TransitionGuardError(state.tag, event, "recording ID does not match");
  }
}

function failureStageForStopReason(reason: StopReason): FailureStage {
  switch (reason) {
    case StopReason.RecordingFailed:
      return FailureStage.Recording;
    case StopReason.ConnectionRecoveryExhausted:
      return FailureStage.Recovery;
    case StopReason.ReadinessDeadlineExceeded:
      return FailureStage.BridgeReadiness;
    case StopReason.FatalTransportError:
    case StopReason.TimeLimitReached:
    case StopReason.UserRequested:
      return FailureStage.Shutdown;
  }
}
