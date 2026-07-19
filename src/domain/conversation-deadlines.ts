/** Pure deadline selection for the provider-neutral conversation aggregate. */
import {
  ArtifactStatus,
  ConversationEventType,
  ConversationStateTag,
  TransportStatus,
  isTransportTerminal,
  value,
  type ConversationEvent,
  type ConversationState,
  type UnixMillis,
} from "./conversation-state-machine";

export const ALARM_EVENT_ID_PREFIX = "system:alarm:";
export const ALARM_SHUTDOWN_GRACE_MS = 15_000;
export const TRANSPORT_RECOVERY_WINDOW_MS = 20_000;
export const MAXIMUM_LIVE_DURATION_MS = 20 * 60_000;

export const deadlineErrorCode = {
  starting: value.errorCode("deadline.starting_exceeded"),
  recovery: value.errorCode("deadline.recovery_exceeded"),
  ending: value.errorCode("deadline.ending_exceeded"),
  artifact: value.errorCode("deadline.artifact_upload_exceeded"),
} as const;

type DeadlineKind = "starting" | "live" | "reconnect" | "ending" | "artifact";
interface DeadlineCandidate {
  readonly kind: DeadlineKind;
  readonly at: UnixMillis;
}

export function deadlineForState(state: ConversationState): UnixMillis | null {
  return earliestDeadline(state)?.at ?? null;
}

export function alarmEventId(state: ConversationState, deadline: UnixMillis): string {
  return `${ALARM_EVENT_ID_PREFIX}${state.data.sessionId}:${state.tag}:${state.revision}:${deadline}`;
}

/** Builds the event for the earliest active deadline. Due-ness is checked by the caller. */
export function deadlineEventForState(
  state: ConversationState,
  at: UnixMillis,
): ConversationEvent | null {
  const deadline = earliestDeadline(state);
  if (deadline === null) return null;

  const eventId = alarmEventId(state, deadline.at);
  const endingDeadlineAt = value.unixMillis(Number(at) + ALARM_SHUTDOWN_GRACE_MS);
  switch (deadline.kind) {
    case "starting":
      return {
        type: ConversationEventType.StartingDeadlineExceeded,
        eventId,
        at,
        errorCode: deadlineErrorCode.starting,
      };
    case "live":
      return {
        type: ConversationEventType.TimeLimitReached,
        eventId,
        at,
        endingDeadlineAt,
      };
    case "reconnect":
      return {
        type: ConversationEventType.RecoveryDeadlineExceeded,
        eventId,
        at,
        errorCode: deadlineErrorCode.recovery,
        endingDeadlineAt,
      };
    case "ending":
      return {
        type: ConversationEventType.EndingDeadlineExceeded,
        eventId,
        at,
        errorCode: deadlineErrorCode.ending,
      };
    case "artifact":
      return {
        type: ConversationEventType.ArtifactDeadlineExceeded,
        eventId,
        at,
        errorCode: deadlineErrorCode.artifact,
        endingDeadlineAt,
      };
  }
}

function earliestDeadline(state: ConversationState): DeadlineCandidate | null {
  const candidates: DeadlineCandidate[] = [];

  if (state.tag === ConversationStateTag.Starting) {
    candidates.push({ kind: "starting", at: state.data.startDeadlineAt });
  }
  if (state.tag === ConversationStateTag.Live) {
    if (state.data.transport.status === TransportStatus.Reconnecting) {
      candidates.push({ kind: "reconnect", at: state.data.transport.deadlineAt });
    }
    candidates.push({ kind: "live", at: state.data.maximumEndAt });
  }
  if (state.tag === ConversationStateTag.Ending) {
    const waitingForUpload =
      state.data.artifact.status === ArtifactStatus.Pending ||
      state.data.artifact.status === ArtifactStatus.Recording;
    if (!isTransportTerminal(state.data.transport) || waitingForUpload) {
      candidates.push({ kind: "ending", at: state.data.deadlineAt });
    }
  }
  if (state.data.artifact.status === ArtifactStatus.Uploading) {
    candidates.push({ kind: "artifact", at: state.data.artifact.deadlineAt });
  }

  return candidates.reduce<DeadlineCandidate | null>(
    (earliest, candidate) =>
      earliest === null || Number(candidate.at) < Number(earliest.at) ? candidate : earliest,
    null,
  );
}
