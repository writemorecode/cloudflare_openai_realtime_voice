/** Maps internal aggregate states to sanitized conversation-state DTOs for browser clients. */
import { deadlineForState } from "../../domain/conversation-deadlines";
import {
  ArtifactStatus,
  ConversationStateTag,
  TransportStatus,
  type ArtifactState,
  type ConversationState,
  type FailureStage,
  type StopReason,
  type TransportState,
  type UnixMillis,
} from "../../domain/conversation-state-machine";

export type TransportStateDto =
  | Readonly<{ status: TransportStatus.Idle }>
  | Readonly<{ status: TransportStatus.Connecting; epoch: number }>
  | Readonly<{ status: TransportStatus.Connected; epoch: number }>
  | Readonly<{
      status: TransportStatus.Reconnecting;
      epoch: number;
      attempt: number;
      lastErrorCode: string;
    }>
  | Readonly<{ status: TransportStatus.Closed; epoch: number }>
  | Readonly<{ status: TransportStatus.Failed; epoch: number; errorCode: string }>;

export type ArtifactStateDto =
  | Readonly<{ status: ArtifactStatus.Pending }>
  | Readonly<{ status: ArtifactStatus.Recording }>
  | Readonly<{ status: ArtifactStatus.Uploading }>
  | Readonly<{ status: ArtifactStatus.Ready }>
  | Readonly<{ status: ArtifactStatus.Failed; errorCode: string }>;

interface StateDtoBase {
  readonly conversationId: string;
  readonly state: ConversationStateTag;
  readonly revision: number;
  readonly enteredAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly activeDeadlineAt: UnixMillis | null;
  readonly transport: TransportStateDto;
  readonly artifact: ArtifactStateDto;
}

export type ConversationStateDto = StateDtoBase &
  Readonly<{
    starting?: { startDeadlineAt: UnixMillis } | undefined;
    live?: { startedAt: UnixMillis; maximumEndAt: UnixMillis } | undefined;
    ending?: { target: "complete" | "cancel" | "fail" } | undefined;
    completed?: { completedAt: UnixMillis; terminationReason: StopReason } | undefined;
    cancelled?: { cancelledAt: UnixMillis; reason: string } | undefined;
    failed?: { failedAt: UnixMillis; stage: FailureStage; errorCode: string } | undefined;
  }>;

export function toConversationStateDto(state: ConversationState): ConversationStateDto {
  const base: StateDtoBase = {
    conversationId: state.data.sessionId,
    state: state.tag,
    revision: state.revision,
    enteredAt: state.enteredAt,
    updatedAt: state.updatedAt,
    activeDeadlineAt: deadlineForState(state),
    transport: transportDto(state.data.transport),
    artifact: artifactDto(state.data.artifact),
  };

  switch (state.tag) {
    case ConversationStateTag.Created:
      return base;
    case ConversationStateTag.Starting:
      return { ...base, starting: { startDeadlineAt: state.data.startDeadlineAt } };
    case ConversationStateTag.Live:
      return {
        ...base,
        live: { startedAt: state.data.startedAt, maximumEndAt: state.data.maximumEndAt },
      };
    case ConversationStateTag.Ending:
      return { ...base, ending: { target: state.data.target.kind } };
    case ConversationStateTag.Completed:
      return {
        ...base,
        completed: {
          completedAt: state.data.completedAt,
          terminationReason: state.data.terminationReason,
        },
      };
    case ConversationStateTag.Cancelled:
      return {
        ...base,
        cancelled: { cancelledAt: state.data.cancelledAt, reason: state.data.reason },
      };
    case ConversationStateTag.Failed:
      return {
        ...base,
        failed: {
          failedAt: state.data.failedAt,
          stage: state.data.stage,
          errorCode: state.data.errorCode,
        },
      };
  }
}

function transportDto(transport: TransportState): TransportStateDto {
  switch (transport.status) {
    case TransportStatus.Idle:
      return { status: transport.status };
    case TransportStatus.Connecting:
    case TransportStatus.Connected:
    case TransportStatus.Closed:
      return { status: transport.status, epoch: transport.epoch };
    case TransportStatus.Reconnecting:
      return {
        status: transport.status,
        epoch: transport.epoch,
        attempt: transport.attempt,
        lastErrorCode: transport.lastErrorCode,
      };
    case TransportStatus.Failed:
      return {
        status: transport.status,
        epoch: transport.epoch,
        errorCode: transport.errorCode,
      };
  }
}

function artifactDto(artifact: ArtifactState): ArtifactStateDto {
  switch (artifact.status) {
    case ArtifactStatus.Pending:
    case ArtifactStatus.Recording:
    case ArtifactStatus.Uploading:
    case ArtifactStatus.Ready:
      return { status: artifact.status };
    case ArtifactStatus.Failed:
      return { status: artifact.status, errorCode: artifact.errorCode };
  }
}
