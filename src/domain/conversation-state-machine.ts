/**
 * Provider-neutral conversation domain model and pure transition reducer.
 *
 * This module has no Cloudflare, LiveKit, OpenAI, storage, or transport dependencies. Provider
 * payloads must be translated into these events before they enter the conversation aggregate.
 */
import { Result } from "better-result";

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

export type TransitionError =
  | Readonly<{
      kind: "illegal_transition";
      state: ConversationStateTag;
      event: ConversationEventType;
    }>
  | Readonly<{
      kind: "guard_failed";
      state: ConversationStateTag;
      event: ConversationEventType;
      reason: string;
    }>;

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
): Result<NextState<S["tag"], E>, TransitionError> {
  return transitionRuntime(state, event) as Result<NextState<S["tag"], E>, TransitionError>;
}

export function transitionRuntime(
  state: ConversationState,
  event: ConversationEvent,
): Result<ConversationState, TransitionError> {
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
      return illegalTransition(state, event);
  }
}

function fromCreated(
  state: CreatedState,
  event: ConversationEvent,
): Result<ConversationState, TransitionError> {
  switch (event.type) {
    case ConversationEventType.StartRequested:
      return Result.ok(
        enter(state, ConversationStateTag.Starting, event.at, {
          startDeadlineAt: event.startDeadlineAt,
          transport: { status: TransportStatus.Connecting, epoch: 1, sinceAt: event.at },
        }),
      );
    case ConversationEventType.EndRequested:
      return Result.ok(
        enter(state, ConversationStateTag.Cancelled, event.at, {
          cancelledAt: event.at,
          reason: event.reason,
        }),
      );
    default:
      return illegalTransition(state, event);
  }
}

function fromStarting(
  state: StartingState,
  event: ConversationEvent,
): Result<ConversationState, TransitionError> {
  switch (event.type) {
    case ConversationEventType.TransportConnected: {
      const failure = requireConnectingEpoch(state, event.type, event.epoch);
      if (failure !== null) return Result.err(failure);
      return Result.ok(
        revise(state, event.at, {
          transport: {
            status: TransportStatus.Connected,
            epoch: event.epoch,
            connectedAt: event.at,
          },
        }),
      );
    }
    case ConversationEventType.RecordingStarted: {
      const failure = guard(
        state,
        event.type,
        state.data.artifact.status === ArtifactStatus.Pending,
        "artifact must be pending",
      );
      if (failure !== null) return Result.err(failure);
      return Result.ok(
        revise(state, event.at, {
          artifact: {
            status: ArtifactStatus.Recording,
            recordingId: event.recordingId,
            startedAt: event.at,
          },
        }),
      );
    }
    case ConversationEventType.SessionStarted: {
      const epochFailure = requireConnectedEpoch(state, event.type, event.epoch);
      if (epochFailure !== null) return Result.err(epochFailure);
      const artifactFailure = guard(
        state,
        event.type,
        state.data.artifact.status === ArtifactStatus.Recording,
        "artifact must be recording",
      );
      if (artifactFailure !== null) return Result.err(artifactFailure);
      return Result.ok(
        enter(state, ConversationStateTag.Live, event.at, {
          startedAt: event.at,
          maximumEndAt: event.maximumEndAt,
        }),
      );
    }
    case ConversationEventType.EndRequested:
      return Result.ok(
        enter(state, ConversationStateTag.Ending, event.at, {
          target: { kind: "cancel", reason: event.reason },
          deadlineAt: event.endingDeadlineAt,
        }),
      );
    case ConversationEventType.FatalTransportError: {
      const failure = requireCurrentEpoch(state, event.type, event.epoch);
      return failure === null
        ? Result.ok(failTerminalTransport(state, event, FailureStage.Transport))
        : Result.err(failure);
    }
    case ConversationEventType.SessionClosed: {
      const failure = requireCurrentEpoch(state, event.type, event.epoch);
      if (failure !== null) return Result.err(failure);
      return Result.ok(
        failWithClosedTransport(
          state,
          event,
          FailureStage.Starting,
          value.errorCode("starting.session_closed"),
        ),
      );
    }
    case ConversationEventType.ArtifactFailed:
      return beginFailedEnding(state, event, FailureStage.Artifact);
    case ConversationEventType.StartingDeadlineExceeded:
      return Result.ok(
        failWithFailedTransport(state, event, FailureStage.Starting, event.errorCode),
      );
    default:
      return illegalTransition(state, event);
  }
}

function fromLive(
  state: LiveState,
  event: ConversationEvent,
): Result<ConversationState, TransitionError> {
  switch (event.type) {
    case ConversationEventType.TransportInterrupted: {
      const epochFailure = requireCurrentEpoch(state, event.type, event.epoch);
      if (epochFailure !== null) return Result.err(epochFailure);
      const transport = state.data.transport;
      const transportFailure = guard(
        state,
        event.type,
        transport.status === TransportStatus.Connected ||
          transport.status === TransportStatus.Reconnecting,
        "transport must be connected or reconnecting",
      );
      if (transportFailure !== null) return Result.err(transportFailure);
      return Result.ok(
        revise(state, event.at, {
          transport: {
            status: TransportStatus.Reconnecting,
            epoch: event.epoch,
            interruptedAt:
              transport.status === TransportStatus.Reconnecting
                ? transport.interruptedAt
                : event.at,
            deadlineAt:
              transport.status === TransportStatus.Reconnecting
                ? transport.deadlineAt
                : event.recoveryDeadlineAt,
            attempt: transport.status === TransportStatus.Reconnecting ? transport.attempt + 1 : 1,
            lastErrorCode: event.errorCode,
          },
        }),
      );
    }
    case ConversationEventType.TransportConnected: {
      const failure = requireReconnectEpoch(state, event.type, event.epoch);
      if (failure !== null) return Result.err(failure);
      return Result.ok(
        revise(state, event.at, {
          transport: {
            status: TransportStatus.Connected,
            epoch: event.epoch,
            connectedAt: event.at,
          },
        }),
      );
    }
    case ConversationEventType.RecoveryDeadlineExceeded: {
      const failure = guard(
        state,
        event.type,
        state.data.transport.status === TransportStatus.Reconnecting,
        "transport must be reconnecting",
      );
      return failure === null
        ? Result.ok(failWithFailedTransport(state, event, FailureStage.Transport, event.errorCode))
        : Result.err(failure);
    }
    case ConversationEventType.EndRequested:
      return Result.ok(
        enter(state, ConversationStateTag.Ending, event.at, {
          target: { kind: "complete", reason: StopReason.UserRequested },
          deadlineAt: event.endingDeadlineAt,
        }),
      );
    case ConversationEventType.TimeLimitReached:
      return Result.ok(
        enter(state, ConversationStateTag.Ending, event.at, {
          target: { kind: "complete", reason: StopReason.TimeLimitReached },
          deadlineAt: event.endingDeadlineAt,
        }),
      );
    case ConversationEventType.FatalTransportError: {
      const failure = requireCurrentEpoch(state, event.type, event.epoch);
      return failure === null
        ? Result.ok(failTerminalTransport(state, event, FailureStage.Transport))
        : Result.err(failure);
    }
    case ConversationEventType.SessionClosed: {
      const failure = requireCurrentEpoch(state, event.type, event.epoch);
      if (failure !== null) return Result.err(failure);
      return Result.ok(
        failWithClosedTransport(
          state,
          event,
          FailureStage.Transport,
          value.errorCode("transport.unexpected_close"),
        ),
      );
    }
    case ConversationEventType.ArtifactFailed:
      return beginFailedEnding(state, event, FailureStage.Artifact);
    default:
      return illegalTransition(state, event);
  }
}

function fromEnding(
  state: EndingState,
  event: ConversationEvent,
): Result<ConversationState, TransitionError> {
  switch (event.type) {
    case ConversationEventType.TransportConnected: {
      const failure = requireReconnectEpoch(state, event.type, event.epoch);
      if (failure !== null) return Result.err(failure);
      return Result.ok(
        revise(state, event.at, {
          transport: {
            status: TransportStatus.Connected,
            epoch: event.epoch,
            connectedAt: event.at,
          },
        }),
      );
    }
    case ConversationEventType.SessionClosed: {
      const failure = requireCurrentEpoch(state, event.type, event.epoch);
      if (failure !== null) return Result.err(failure);
      return Result.ok(
        finalizeIfReady(
          revise(state, event.at, {
            transport: { status: TransportStatus.Closed, epoch: event.epoch, closedAt: event.at },
          }),
          event.at,
        ),
      );
    }
    case ConversationEventType.RecordingUploadStarted: {
      const failure = guardRecordingId(state, event.type, event.recordingId);
      if (failure !== null) return Result.err(failure);
      return Result.ok(
        revise(state, event.at, {
          artifact: {
            status: ArtifactStatus.Uploading,
            recordingId: event.recordingId,
            expectedR2Key: event.expectedR2Key,
            startedAt: event.at,
            deadlineAt: event.artifactDeadlineAt,
          },
        }),
      );
    }
    case ConversationEventType.RecordingArtifactVerified: {
      const statusFailure = guard(
        state,
        event.type,
        state.data.artifact.status === ArtifactStatus.Uploading,
        "artifact must be uploading",
      );
      if (statusFailure !== null) return Result.err(statusFailure);
      const idFailure = guardRecordingId(state, event.type, event.recordingId);
      if (idFailure !== null) return Result.err(idFailure);
      if (state.data.artifact.status === ArtifactStatus.Uploading) {
        const keyFailure = guard(
          state,
          event.type,
          state.data.artifact.expectedR2Key === event.r2Key,
          "artifact key does not match expected key",
        );
        if (keyFailure !== null) return Result.err(keyFailure);
      }
      return Result.ok(
        finalizeIfReady(
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
        ),
      );
    }
    case ConversationEventType.ArtifactFailed: {
      const artifact = failedArtifact(state, event.recordingId, event.at, event.errorCode);
      if (!artifact.isOk()) return artifact;
      return Result.ok(
        finalizeIfReady(
          revise(state, event.at, {
            target: { kind: "fail", stage: FailureStage.Artifact, errorCode: event.errorCode },
            deadlineAt: event.endingDeadlineAt,
            artifact: artifact.value,
          }),
          event.at,
        ),
      );
    }
    case ConversationEventType.FatalTransportError: {
      const failure = requireCurrentEpoch(state, event.type, event.epoch);
      if (failure !== null) return Result.err(failure);
      return Result.ok(
        finalizeIfReady(
          revise(state, event.at, {
            target: { kind: "fail", stage: FailureStage.Transport, errorCode: event.errorCode },
            deadlineAt: event.endingDeadlineAt,
            transport: failedTransport(state, event.at, event.errorCode),
          }),
          event.at,
        ),
      );
    }
    case ConversationEventType.EndingDeadlineExceeded: {
      const stage = isTransportTerminal(state.data.transport)
        ? FailureStage.Artifact
        : FailureStage.Ending;
      const artifact =
        stage === FailureStage.Artifact && state.data.artifact.status !== ArtifactStatus.Ready
          ? failedArtifactState(state, null, event.at, event.errorCode)
          : state.data.artifact;
      return Result.ok(
        enter(state, ConversationStateTag.Failed, event.at, {
          failedAt: event.at,
          stage,
          errorCode: event.errorCode,
          transport: isTransportTerminal(state.data.transport)
            ? state.data.transport
            : failedTransport(state, event.at, event.errorCode),
          artifact,
        }),
      );
    }
    case ConversationEventType.ArtifactDeadlineExceeded: {
      const failure = guard(
        state,
        event.type,
        state.data.artifact.status === ArtifactStatus.Uploading,
        "artifact must be uploading",
      );
      if (failure !== null) return Result.err(failure);
      return Result.ok(
        finalizeIfReady(
          revise(state, event.at, {
            target: { kind: "fail", stage: FailureStage.Artifact, errorCode: event.errorCode },
            deadlineAt: event.endingDeadlineAt,
            artifact: failedArtifactState(state, null, event.at, event.errorCode),
          }),
          event.at,
        ),
      );
    }
    default:
      return illegalTransition(state, event);
  }
}

function beginFailedEnding(
  state: StartingState | LiveState,
  event: ArtifactFailedEvent,
  stage: FailureStage,
): Result<EndingState | FailedState, TransitionError> {
  const artifact = failedArtifact(state, event.recordingId, event.at, event.errorCode);
  if (!artifact.isOk()) return artifact;
  const ending = enter(state, ConversationStateTag.Ending, event.at, {
    target: { kind: "fail", stage, errorCode: event.errorCode },
    deadlineAt: event.endingDeadlineAt,
    artifact: artifact.value,
  });
  return Result.ok(finalizeIfReady(ending, event.at) as EndingState | FailedState);
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
): Result<ArtifactState, TransitionGuardError> {
  const currentId =
    state.data.artifact.status === ArtifactStatus.Pending ? null : state.data.artifact.recordingId;
  if (suppliedId !== null && currentId !== null) {
    const failure = guard(
      state,
      ConversationEventType.ArtifactFailed,
      suppliedId === currentId,
      "recording id mismatch",
    );
    if (failure !== null) return Result.err(failure);
  }
  return Result.ok(failedArtifactState(state, suppliedId, at, errorCode));
}

function failedArtifactState(
  state: ConversationState,
  suppliedId: RecordingId | null,
  at: UnixMillis,
  errorCode: ErrorCode,
): ArtifactState {
  const currentId =
    state.data.artifact.status === ArtifactStatus.Pending ? null : state.data.artifact.recordingId;
  return {
    status: ArtifactStatus.Failed,
    recordingId: suppliedId ?? currentId,
    failedAt: at,
    errorCode,
  };
}

type TransitionGuardError = Extract<TransitionError, { kind: "guard_failed" }>;

function guardRecordingId(
  state: ConversationState,
  event: ConversationEventType,
  recordingId: RecordingId,
): TransitionGuardError | null {
  const artifact = state.data.artifact;
  return guard(
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
): TransitionGuardError | null {
  return guard(
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
): TransitionGuardError | null {
  return guard(
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
): TransitionGuardError | null {
  return guard(
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
): TransitionGuardError | null {
  return guard(
    state,
    event,
    transportEpoch(state.data.transport) === epoch,
    "transport epoch mismatch",
  );
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
): TransitionGuardError | null {
  return condition ? null : { kind: "guard_failed", state: state.tag, event, reason };
}

function illegalTransition(
  state: ConversationState,
  event: ConversationEvent,
): Result<never, TransitionError> {
  return Result.err({ kind: "illegal_transition", state: state.tag, event: event.type });
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
