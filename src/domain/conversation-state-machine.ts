/**
 * Provider-neutral conversation domain model and pure transition reducer.
 *
 * This module has no Cloudflare, LiveKit, OpenAI, storage, or transport dependencies. Provider
 * payloads must be translated into these events before they enter the conversation aggregate.
 */
const opaqueBrand: unique symbol = Symbol("opaqueBrand");

type Opaque<Name extends string, Value> = Value & { readonly [opaqueBrand]: Name };

function opaque<Name extends string, Value>(input: Value): Opaque<Name, Value> {
  return input as Opaque<Name, Value>;
}

export type ConversationSessionId = Opaque<"ConversationSessionId", string>;
export type RecordingId = Opaque<"RecordingId", string>;
export type R2ObjectKey = Opaque<"R2ObjectKey", string>;
export type R2Etag = Opaque<"R2Etag", string>;
export type ErrorCode = Opaque<"ErrorCode", string>;
export type UnixMillis = Opaque<"UnixMillis", number>;

export const value = {
  conversationSessionId: (input: string): ConversationSessionId =>
    opaque<"ConversationSessionId", string>(input),
  errorCode: (input: string): ErrorCode => opaque<"ErrorCode", string>(input),
  r2Etag: (input: string): R2Etag => opaque<"R2Etag", string>(input),
  r2ObjectKey: (input: string): R2ObjectKey => opaque<"R2ObjectKey", string>(input),
  recordingId: (input: string): RecordingId => opaque<"RecordingId", string>(input),
  unixMillis: (input: number): UnixMillis => opaque<"UnixMillis", number>(input),
};

export enum ConversationStateTag {
  Created = "created",
  Starting = "starting",
  Live = "live",
  Ending = "ending",
  Completed = "completed",
  Cancelled = "cancelled",
  Failed = "failed",
}

export enum TransportStatus {
  Idle = "idle",
  Connecting = "connecting",
  Connected = "connected",
  Reconnecting = "reconnecting",
  Closed = "closed",
  Failed = "failed",
}

export enum ArtifactStatus {
  Pending = "pending",
  Recording = "recording",
  Uploading = "uploading",
  Ready = "ready",
  Failed = "failed",
}

export enum ConversationEventType {
  StartRequested = "start_requested",
  TransportConnected = "transport_connected",
  RecordingStarted = "recording_started",
  SessionStarted = "session_started",
  TransportInterrupted = "transport_interrupted",
  RecoveryDeadlineExceeded = "recovery_deadline_exceeded",
  EndRequested = "end_requested",
  TimeLimitReached = "time_limit_reached",
  FatalTransportError = "fatal_transport_error",
  SessionClosed = "session_closed",
  RecordingUploadStarted = "recording_upload_started",
  RecordingArtifactVerified = "recording_artifact_verified",
  ArtifactFailed = "artifact_failed",
  StartingDeadlineExceeded = "starting_deadline_exceeded",
  EndingDeadlineExceeded = "ending_deadline_exceeded",
  ArtifactDeadlineExceeded = "artifact_deadline_exceeded",
}

export enum StopReason {
  UserRequested = "user_requested",
  TimeLimitReached = "time_limit_reached",
}

export enum FailureStage {
  Starting = "starting",
  Transport = "transport",
  Artifact = "artifact",
  Ending = "ending",
}

export type TransportState =
  | Readonly<{ status: TransportStatus.Idle }>
  | Readonly<{ status: TransportStatus.Connecting; epoch: number; sinceAt: UnixMillis }>
  | Readonly<{ status: TransportStatus.Connected; epoch: number; connectedAt: UnixMillis }>
  | Readonly<{
      status: TransportStatus.Reconnecting;
      epoch: number;
      interruptedAt: UnixMillis;
      deadlineAt: UnixMillis;
      attempt: number;
      lastErrorCode: ErrorCode;
    }>
  | Readonly<{ status: TransportStatus.Closed; epoch: number; closedAt: UnixMillis }>
  | Readonly<{
      status: TransportStatus.Failed;
      epoch: number;
      failedAt: UnixMillis;
      errorCode: ErrorCode;
    }>;

export type ArtifactState =
  | Readonly<{ status: ArtifactStatus.Pending }>
  | Readonly<{ status: ArtifactStatus.Recording; recordingId: RecordingId; startedAt: UnixMillis }>
  | Readonly<{
      status: ArtifactStatus.Uploading;
      recordingId: RecordingId;
      expectedR2Key: R2ObjectKey;
      startedAt: UnixMillis;
      deadlineAt: UnixMillis;
    }>
  | Readonly<{
      status: ArtifactStatus.Ready;
      recordingId: RecordingId;
      r2Key: R2ObjectKey;
      r2Etag: R2Etag;
      readyAt: UnixMillis;
    }>
  | Readonly<{
      status: ArtifactStatus.Failed;
      recordingId: RecordingId | null;
      failedAt: UnixMillis;
      errorCode: ErrorCode;
    }>;

interface AggregateData {
  readonly sessionId: ConversationSessionId;
  readonly transport: TransportState;
  readonly artifact: ArtifactState;
}

type StateVariant<K extends ConversationStateTag, D = object> = Readonly<{
  tag: K;
  revision: number;
  enteredAt: UnixMillis;
  updatedAt: UnixMillis;
  data: Readonly<AggregateData & D>;
}>;

export type CreatedState = StateVariant<ConversationStateTag.Created>;
export type StartingState = StateVariant<
  ConversationStateTag.Starting,
  { startDeadlineAt: UnixMillis }
>;
export type LiveState = StateVariant<
  ConversationStateTag.Live,
  { startedAt: UnixMillis; maximumEndAt: UnixMillis }
>;

export type EndTarget =
  | Readonly<{ kind: "complete"; reason: StopReason }>
  | Readonly<{ kind: "cancel"; reason: string }>
  | Readonly<{ kind: "fail"; stage: FailureStage; errorCode: ErrorCode }>;

export type EndingState = StateVariant<
  ConversationStateTag.Ending,
  { target: EndTarget; deadlineAt: UnixMillis }
>;
export type CompletedState = StateVariant<
  ConversationStateTag.Completed,
  { completedAt: UnixMillis; terminationReason: StopReason }
>;
export type CancelledState = StateVariant<
  ConversationStateTag.Cancelled,
  { cancelledAt: UnixMillis; reason: string }
>;
export type FailedState = StateVariant<
  ConversationStateTag.Failed,
  { failedAt: UnixMillis; stage: FailureStage; errorCode: ErrorCode }
>;

export interface ConversationStateByTag {
  [ConversationStateTag.Created]: CreatedState;
  [ConversationStateTag.Starting]: StartingState;
  [ConversationStateTag.Live]: LiveState;
  [ConversationStateTag.Ending]: EndingState;
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
  { startDeadlineAt: UnixMillis }
>;
export type TransportConnectedEvent = EventVariant<
  ConversationEventType.TransportConnected,
  { epoch: number }
>;
export type RecordingStartedEvent = EventVariant<
  ConversationEventType.RecordingStarted,
  { recordingId: RecordingId }
>;
export type SessionStartedEvent = EventVariant<
  ConversationEventType.SessionStarted,
  { epoch: number; maximumEndAt: UnixMillis }
>;
export type TransportInterruptedEvent = EventVariant<
  ConversationEventType.TransportInterrupted,
  { epoch: number; errorCode: ErrorCode; recoveryDeadlineAt: UnixMillis }
>;
export type RecoveryDeadlineExceededEvent = EventVariant<
  ConversationEventType.RecoveryDeadlineExceeded,
  { errorCode: ErrorCode; endingDeadlineAt: UnixMillis }
>;
export type EndRequestedEvent = EventVariant<
  ConversationEventType.EndRequested,
  { reason: string; endingDeadlineAt: UnixMillis }
>;
export type TimeLimitReachedEvent = EventVariant<
  ConversationEventType.TimeLimitReached,
  { endingDeadlineAt: UnixMillis }
>;
export type FatalTransportErrorEvent = EventVariant<
  ConversationEventType.FatalTransportError,
  { epoch: number; errorCode: ErrorCode; endingDeadlineAt: UnixMillis }
>;
export type SessionClosedEvent = EventVariant<
  ConversationEventType.SessionClosed,
  { epoch: number }
>;
export type RecordingUploadStartedEvent = EventVariant<
  ConversationEventType.RecordingUploadStarted,
  { recordingId: RecordingId; expectedR2Key: R2ObjectKey; artifactDeadlineAt: UnixMillis }
>;
export type RecordingArtifactVerifiedEvent = EventVariant<
  ConversationEventType.RecordingArtifactVerified,
  { recordingId: RecordingId; r2Key: R2ObjectKey; r2Etag: R2Etag }
>;
export type ArtifactFailedEvent = EventVariant<
  ConversationEventType.ArtifactFailed,
  {
    recordingId: RecordingId | null;
    errorCode: ErrorCode;
    endingDeadlineAt: UnixMillis;
  }
>;
export type StartingDeadlineExceededEvent = EventVariant<
  ConversationEventType.StartingDeadlineExceeded,
  { errorCode: ErrorCode }
>;
export type EndingDeadlineExceededEvent = EventVariant<
  ConversationEventType.EndingDeadlineExceeded,
  { errorCode: ErrorCode }
>;
export type ArtifactDeadlineExceededEvent = EventVariant<
  ConversationEventType.ArtifactDeadlineExceeded,
  { errorCode: ErrorCode; endingDeadlineAt: UnixMillis }
>;

export type ConversationEvent =
  | StartRequestedEvent
  | TransportConnectedEvent
  | RecordingStartedEvent
  | SessionStartedEvent
  | TransportInterruptedEvent
  | RecoveryDeadlineExceededEvent
  | EndRequestedEvent
  | TimeLimitReachedEvent
  | FatalTransportErrorEvent
  | SessionClosedEvent
  | RecordingUploadStartedEvent
  | RecordingArtifactVerifiedEvent
  | ArtifactFailedEvent
  | StartingDeadlineExceededEvent
  | EndingDeadlineExceededEvent
  | ArtifactDeadlineExceededEvent;

interface TransitionTargets {
  [ConversationStateTag.Created]: {
    [ConversationEventType.StartRequested]: StartingState;
    [ConversationEventType.EndRequested]: CancelledState;
  };
  [ConversationStateTag.Starting]: {
    [ConversationEventType.TransportConnected]: StartingState;
    [ConversationEventType.RecordingStarted]: StartingState;
    [ConversationEventType.SessionStarted]: LiveState;
    [ConversationEventType.EndRequested]: EndingState;
    [ConversationEventType.FatalTransportError]: FailedState;
    [ConversationEventType.SessionClosed]: FailedState;
    [ConversationEventType.ArtifactFailed]: EndingState | FailedState;
    [ConversationEventType.StartingDeadlineExceeded]: FailedState;
  };
  [ConversationStateTag.Live]: {
    [ConversationEventType.TransportConnected]: LiveState;
    [ConversationEventType.TransportInterrupted]: LiveState;
    [ConversationEventType.RecoveryDeadlineExceeded]: FailedState;
    [ConversationEventType.EndRequested]: EndingState;
    [ConversationEventType.TimeLimitReached]: EndingState;
    [ConversationEventType.FatalTransportError]: FailedState;
    [ConversationEventType.SessionClosed]: FailedState;
    [ConversationEventType.ArtifactFailed]: EndingState;
  };
  [ConversationStateTag.Ending]: {
    [ConversationEventType.TransportConnected]: EndingState;
    [ConversationEventType.SessionClosed]:
      | EndingState
      | CompletedState
      | CancelledState
      | FailedState;
    [ConversationEventType.RecordingUploadStarted]: EndingState;
    [ConversationEventType.RecordingArtifactVerified]: EndingState | CompletedState;
    [ConversationEventType.ArtifactFailed]: EndingState | FailedState;
    [ConversationEventType.FatalTransportError]: EndingState | FailedState;
    [ConversationEventType.EndingDeadlineExceeded]: FailedState;
    [ConversationEventType.ArtifactDeadlineExceeded]: EndingState | FailedState;
  };
}

export type TransitionableStateTag = keyof TransitionTargets;
export type TransitionableState = ConversationStateByTag[TransitionableStateTag];
export type AllowedEventType<K extends TransitionableStateTag> = keyof TransitionTargets[K] &
  ConversationEventType;
export type AllowedEvent<K extends TransitionableStateTag> = Extract<
  ConversationEvent,
  { type: AllowedEventType<K> }
>;
export type NextState<
  K extends TransitionableStateTag,
  E extends AllowedEventType<K>,
> = E extends keyof TransitionTargets[K] ? TransitionTargets[K][E] : never;

type IsUnion<T, Whole = T> = T extends unknown ? ([Whole] extends [T] ? false : true) : never;
type RequireSingleState<S extends TransitionableState> = true extends IsUnion<S["tag"]> ? never : S;

export class IllegalTransitionError extends Error {
  constructor(
    readonly state: ConversationStateTag,
    readonly event: ConversationEventType,
  ) {
    super(`Event ${event} is illegal from state ${state}`);
    this.name = "IllegalTransitionError";
  }
}

export class TransitionGuardError extends Error {
  constructor(
    readonly state: ConversationStateTag,
    readonly event: ConversationEventType,
    readonly reason: string,
  ) {
    super(`Transition ${state} + ${event} failed guard: ${reason}`);
    this.name = "TransitionGuardError";
  }
}

export function createConversation(sessionId: ConversationSessionId, at: UnixMillis): CreatedState {
  return {
    tag: ConversationStateTag.Created,
    revision: 0,
    enteredAt: at,
    updatedAt: at,
    data: {
      sessionId,
      transport: { status: TransportStatus.Idle },
      artifact: { status: ArtifactStatus.Pending },
    },
  };
}

export function transition<S extends TransitionableState, E extends AllowedEventType<S["tag"]>>(
  state: RequireSingleState<S>,
  event: Extract<ConversationEvent, { type: E }>,
): NextState<S["tag"], E> {
  return transitionRuntime(state, event) as NextState<S["tag"], E>;
}

export function transitionRuntime(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  switch (state.tag) {
    case ConversationStateTag.Created:
      return fromCreated(state, event);
    case ConversationStateTag.Starting:
      return fromStarting(state, event);
    case ConversationStateTag.Live:
      return fromLive(state, event);
    case ConversationStateTag.Ending:
      return fromEnding(state, event);
    case ConversationStateTag.Completed:
    case ConversationStateTag.Cancelled:
    case ConversationStateTag.Failed:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function fromCreated(state: CreatedState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case ConversationEventType.StartRequested:
      return enter(state, ConversationStateTag.Starting, event.at, {
        startDeadlineAt: event.startDeadlineAt,
        transport: { status: TransportStatus.Connecting, epoch: 1, sinceAt: event.at },
      });
    case ConversationEventType.EndRequested:
      return enter(state, ConversationStateTag.Cancelled, event.at, {
        cancelledAt: event.at,
        reason: event.reason,
      });
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function fromStarting(state: StartingState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case ConversationEventType.TransportConnected:
      requireConnectingEpoch(state, event.type, event.epoch);
      return revise(state, event.at, {
        transport: { status: TransportStatus.Connected, epoch: event.epoch, connectedAt: event.at },
      });
    case ConversationEventType.RecordingStarted:
      guard(
        state,
        event.type,
        state.data.artifact.status === ArtifactStatus.Pending,
        "artifact must be pending",
      );
      return revise(state, event.at, {
        artifact: {
          status: ArtifactStatus.Recording,
          recordingId: event.recordingId,
          startedAt: event.at,
        },
      });
    case ConversationEventType.SessionStarted:
      requireConnectedEpoch(state, event.type, event.epoch);
      guard(
        state,
        event.type,
        state.data.artifact.status === ArtifactStatus.Recording,
        "artifact must be recording",
      );
      return enter(state, ConversationStateTag.Live, event.at, {
        startedAt: event.at,
        maximumEndAt: event.maximumEndAt,
      });
    case ConversationEventType.EndRequested:
      return enter(state, ConversationStateTag.Ending, event.at, {
        target: { kind: "cancel", reason: event.reason },
        deadlineAt: event.endingDeadlineAt,
      });
    case ConversationEventType.FatalTransportError:
      requireCurrentEpoch(state, event.type, event.epoch);
      return failTerminalTransport(state, event, FailureStage.Transport);
    case ConversationEventType.SessionClosed:
      requireCurrentEpoch(state, event.type, event.epoch);
      return failWithClosedTransport(
        state,
        event,
        FailureStage.Starting,
        value.errorCode("starting.session_closed"),
      );
    case ConversationEventType.ArtifactFailed:
      return beginFailedEnding(state, event, FailureStage.Artifact);
    case ConversationEventType.StartingDeadlineExceeded:
      return failWithFailedTransport(state, event, FailureStage.Starting, event.errorCode);
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function fromLive(state: LiveState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case ConversationEventType.TransportInterrupted: {
      requireCurrentEpoch(state, event.type, event.epoch);
      const transport = state.data.transport;
      guard(
        state,
        event.type,
        transport.status === TransportStatus.Connected ||
          transport.status === TransportStatus.Reconnecting,
        "transport must be connected or reconnecting",
      );
      return revise(state, event.at, {
        transport: {
          status: TransportStatus.Reconnecting,
          epoch: event.epoch,
          interruptedAt:
            transport.status === TransportStatus.Reconnecting ? transport.interruptedAt : event.at,
          deadlineAt:
            transport.status === TransportStatus.Reconnecting
              ? transport.deadlineAt
              : event.recoveryDeadlineAt,
          attempt: transport.status === TransportStatus.Reconnecting ? transport.attempt + 1 : 1,
          lastErrorCode: event.errorCode,
        },
      });
    }
    case ConversationEventType.TransportConnected:
      requireReconnectEpoch(state, event.type, event.epoch);
      return revise(state, event.at, {
        transport: { status: TransportStatus.Connected, epoch: event.epoch, connectedAt: event.at },
      });
    case ConversationEventType.RecoveryDeadlineExceeded: {
      guard(
        state,
        event.type,
        state.data.transport.status === TransportStatus.Reconnecting,
        "transport must be reconnecting",
      );
      return failWithFailedTransport(state, event, FailureStage.Transport, event.errorCode);
    }
    case ConversationEventType.EndRequested:
      return enter(state, ConversationStateTag.Ending, event.at, {
        target: { kind: "complete", reason: StopReason.UserRequested },
        deadlineAt: event.endingDeadlineAt,
      });
    case ConversationEventType.TimeLimitReached:
      return enter(state, ConversationStateTag.Ending, event.at, {
        target: { kind: "complete", reason: StopReason.TimeLimitReached },
        deadlineAt: event.endingDeadlineAt,
      });
    case ConversationEventType.FatalTransportError:
      requireCurrentEpoch(state, event.type, event.epoch);
      return failTerminalTransport(state, event, FailureStage.Transport);
    case ConversationEventType.SessionClosed:
      requireCurrentEpoch(state, event.type, event.epoch);
      return failWithClosedTransport(
        state,
        event,
        FailureStage.Transport,
        value.errorCode("transport.unexpected_close"),
      );
    case ConversationEventType.ArtifactFailed:
      return beginFailedEnding(state, event, FailureStage.Artifact);
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function fromEnding(state: EndingState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case ConversationEventType.TransportConnected:
      requireReconnectEpoch(state, event.type, event.epoch);
      return revise(state, event.at, {
        transport: { status: TransportStatus.Connected, epoch: event.epoch, connectedAt: event.at },
      });
    case ConversationEventType.SessionClosed:
      requireCurrentEpoch(state, event.type, event.epoch);
      return finalizeIfReady(
        revise(state, event.at, {
          transport: { status: TransportStatus.Closed, epoch: event.epoch, closedAt: event.at },
        }),
        event.at,
      );
    case ConversationEventType.RecordingUploadStarted:
      guardRecordingId(state, event.type, event.recordingId);
      return revise(state, event.at, {
        artifact: {
          status: ArtifactStatus.Uploading,
          recordingId: event.recordingId,
          expectedR2Key: event.expectedR2Key,
          startedAt: event.at,
          deadlineAt: event.artifactDeadlineAt,
        },
      });
    case ConversationEventType.RecordingArtifactVerified:
      guard(
        state,
        event.type,
        state.data.artifact.status === ArtifactStatus.Uploading,
        "artifact must be uploading",
      );
      guardRecordingId(state, event.type, event.recordingId);
      if (state.data.artifact.status === ArtifactStatus.Uploading) {
        guard(
          state,
          event.type,
          state.data.artifact.expectedR2Key === event.r2Key,
          "artifact key does not match expected key",
        );
      }
      return finalizeIfReady(
        revise(state, event.at, {
          artifact: {
            status: ArtifactStatus.Ready,
            recordingId: event.recordingId,
            r2Key: event.r2Key,
            r2Etag: event.r2Etag,
            readyAt: event.at,
          },
        }),
        event.at,
      );
    case ConversationEventType.ArtifactFailed:
      return finalizeIfReady(
        revise(state, event.at, {
          target: { kind: "fail", stage: FailureStage.Artifact, errorCode: event.errorCode },
          deadlineAt: event.endingDeadlineAt,
          artifact: failedArtifact(state, event.recordingId, event.at, event.errorCode),
        }),
        event.at,
      );
    case ConversationEventType.FatalTransportError:
      requireCurrentEpoch(state, event.type, event.epoch);
      return finalizeIfReady(
        revise(state, event.at, {
          target: { kind: "fail", stage: FailureStage.Transport, errorCode: event.errorCode },
          deadlineAt: event.endingDeadlineAt,
          transport: failedTransport(state, event.at, event.errorCode),
        }),
        event.at,
      );
    case ConversationEventType.EndingDeadlineExceeded: {
      const stage = isTransportTerminal(state.data.transport)
        ? FailureStage.Artifact
        : FailureStage.Ending;
      return enter(state, ConversationStateTag.Failed, event.at, {
        failedAt: event.at,
        stage,
        errorCode: event.errorCode,
        transport: isTransportTerminal(state.data.transport)
          ? state.data.transport
          : failedTransport(state, event.at, event.errorCode),
        artifact:
          stage === FailureStage.Artifact && state.data.artifact.status !== ArtifactStatus.Ready
            ? failedArtifact(state, null, event.at, event.errorCode)
            : state.data.artifact,
      });
    }
    case ConversationEventType.ArtifactDeadlineExceeded:
      guard(
        state,
        event.type,
        state.data.artifact.status === ArtifactStatus.Uploading,
        "artifact must be uploading",
      );
      return finalizeIfReady(
        revise(state, event.at, {
          target: { kind: "fail", stage: FailureStage.Artifact, errorCode: event.errorCode },
          deadlineAt: event.endingDeadlineAt,
          artifact: failedArtifact(state, null, event.at, event.errorCode),
        }),
        event.at,
      );
    default:
      throw new IllegalTransitionError(state.tag, event.type);
  }
}

function beginFailedEnding(
  state: StartingState | LiveState,
  event: ArtifactFailedEvent,
  stage: FailureStage,
): EndingState | FailedState {
  const ending = enter(state, ConversationStateTag.Ending, event.at, {
    target: { kind: "fail", stage, errorCode: event.errorCode },
    deadlineAt: event.endingDeadlineAt,
    artifact: failedArtifact(state, event.recordingId, event.at, event.errorCode),
  });
  return finalizeIfReady(ending, event.at) as EndingState | FailedState;
}

function failTerminalTransport(
  state: StartingState | LiveState,
  event: FatalTransportErrorEvent,
  stage: FailureStage,
): FailedState {
  return enter(state, ConversationStateTag.Failed, event.at, {
    failedAt: event.at,
    stage,
    errorCode: event.errorCode,
    transport: failedTransport(state, event.at, event.errorCode),
  });
}

function failWithFailedTransport(
  state: StartingState | LiveState,
  event: { at: UnixMillis },
  stage: FailureStage,
  errorCode: ErrorCode,
): FailedState {
  return enter(state, ConversationStateTag.Failed, event.at, {
    failedAt: event.at,
    stage,
    errorCode,
    transport: failedTransport(state, event.at, errorCode),
  });
}

function failWithClosedTransport(
  state: StartingState | LiveState,
  event: SessionClosedEvent,
  stage: FailureStage,
  errorCode: ErrorCode,
): FailedState {
  return enter(state, ConversationStateTag.Failed, event.at, {
    failedAt: event.at,
    stage,
    errorCode,
    transport: { status: TransportStatus.Closed, epoch: event.epoch, closedAt: event.at },
  });
}

function finalizeIfReady(
  state: EndingState,
  at: UnixMillis,
): EndingState | CompletedState | CancelledState | FailedState {
  if (!isTransportTerminal(state.data.transport)) return state;
  switch (state.data.target.kind) {
    case "complete":
      if (state.data.artifact.status !== ArtifactStatus.Ready) return state;
      return finalize(state, ConversationStateTag.Completed, at, {
        completedAt: at,
        terminationReason: state.data.target.reason,
      });
    case "cancel":
      return finalize(state, ConversationStateTag.Cancelled, at, {
        cancelledAt: at,
        reason: state.data.target.reason,
      });
    case "fail":
      return finalize(state, ConversationStateTag.Failed, at, {
        failedAt: at,
        stage: state.data.target.stage,
        errorCode: state.data.target.errorCode,
      });
  }
}

function failedTransport(
  state: ConversationState,
  at: UnixMillis,
  errorCode: ErrorCode,
): TransportState {
  return {
    status: TransportStatus.Failed,
    epoch: transportEpoch(state.data.transport),
    failedAt: at,
    errorCode,
  };
}

function failedArtifact(
  state: ConversationState,
  suppliedId: RecordingId | null,
  at: UnixMillis,
  errorCode: ErrorCode,
): ArtifactState {
  const currentId =
    state.data.artifact.status === ArtifactStatus.Pending ? null : state.data.artifact.recordingId;
  if (suppliedId !== null && currentId !== null) {
    guard(
      state,
      ConversationEventType.ArtifactFailed,
      suppliedId === currentId,
      "recording id mismatch",
    );
  }
  return {
    status: ArtifactStatus.Failed,
    recordingId: suppliedId ?? currentId,
    failedAt: at,
    errorCode,
  };
}

function guardRecordingId(
  state: ConversationState,
  event: ConversationEventType,
  recordingId: RecordingId,
): void {
  const artifact = state.data.artifact;
  guard(
    state,
    event,
    artifact.status !== ArtifactStatus.Pending && artifact.recordingId === recordingId,
    "recording id mismatch",
  );
}

function requireConnectingEpoch(
  state: ConversationState,
  event: ConversationEventType,
  epoch: number,
): void {
  guard(
    state,
    event,
    state.data.transport.status === TransportStatus.Connecting &&
      state.data.transport.epoch === epoch,
    "transport must be connecting at the supplied epoch",
  );
}

function requireConnectedEpoch(
  state: ConversationState,
  event: ConversationEventType,
  epoch: number,
): void {
  guard(
    state,
    event,
    state.data.transport.status === TransportStatus.Connected &&
      state.data.transport.epoch === epoch,
    "transport must be connected at the supplied epoch",
  );
}

function requireReconnectEpoch(
  state: ConversationState,
  event: ConversationEventType,
  epoch: number,
): void {
  guard(
    state,
    event,
    state.data.transport.status === TransportStatus.Reconnecting &&
      epoch === state.data.transport.epoch + 1,
    "reconnect epoch must increment by one",
  );
}

function requireCurrentEpoch(
  state: ConversationState,
  event: ConversationEventType,
  epoch: number,
): void {
  guard(state, event, transportEpoch(state.data.transport) === epoch, "transport epoch mismatch");
}

function transportEpoch(transport: TransportState): number {
  return transport.status === TransportStatus.Idle ? 0 : transport.epoch;
}

export function isTransportTerminal(transport: TransportState): boolean {
  return transport.status === TransportStatus.Closed || transport.status === TransportStatus.Failed;
}

function guard(
  state: ConversationState,
  event: ConversationEventType,
  condition: boolean,
  reason: string,
): asserts condition {
  if (!condition) throw new TransitionGuardError(state.tag, event, reason);
}

function revise<S extends ConversationState>(
  state: S,
  at: UnixMillis,
  changes: Partial<S["data"]>,
): S {
  return {
    ...state,
    revision: state.revision + 1,
    updatedAt: at,
    data: { ...state.data, ...changes },
  };
}

function enter<K extends ConversationStateTag, S extends ConversationState>(
  state: S,
  tag: K,
  at: UnixMillis,
  changes: object,
): ConversationStateByTag[K] {
  return {
    tag,
    revision: state.revision + 1,
    enteredAt: at,
    updatedAt: at,
    data: { ...state.data, ...changes },
  } as ConversationStateByTag[K];
}

function finalize<K extends ConversationStateTag>(
  state: EndingState,
  tag: K,
  at: UnixMillis,
  changes: object,
): ConversationStateByTag[K] {
  return {
    tag,
    revision: state.revision,
    enteredAt: at,
    updatedAt: at,
    data: { ...state.data, ...changes },
  } as ConversationStateByTag[K];
}
