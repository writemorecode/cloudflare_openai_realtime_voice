/** Maps internal aggregate states to sanitized conversation-state DTOs for browser clients. */
import { deadlineForState } from "../../domain/conversation-deadlines";
import type {
  ArtifactStateDto,
  ConversationStateDto,
  TransportStateDto,
} from "@ai-oral-exam/conversation-contract";
import {
  ArtifactStatus,
  ConversationStateTag,
  TransportStatus,
  type ArtifactState,
  type ConversationState,
  type TransportState,
} from "../../domain/conversation-state-machine";

export type {
  ArtifactStateDto,
  ConversationStateDto,
  TransportStateDto,
} from "@ai-oral-exam/conversation-contract";

export function toConversationStateDto(state: ConversationState): ConversationStateDto {
  const base = {
    conversationId: state.data.sessionId,
    state: state.tag,
    revision: state.revision,
    enteredAt: state.enteredAt,
    updatedAt: state.updatedAt,
    activeDeadlineAt: deadlineForState(state),
    transport: transportDto(state.data.transport),
    artifact: artifactDto(state.data.artifact),
  } satisfies Omit<
    ConversationStateDto,
    "starting" | "live" | "ending" | "completed" | "cancelled" | "failed"
  >;

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
