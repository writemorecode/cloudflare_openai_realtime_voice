/** Stable, provider-neutral state exposed to browser applications. */
import { z } from "zod";

/** Enumerates the lifecycle states of a conversation. */
export const ConversationStateTag = {
  Created: "created",
  Starting: "starting",
  Live: "live",
  Ending: "ending",
  Completed: "completed",
  Cancelled: "cancelled",
  Failed: "failed",
} as const;
/** A lifecycle state of a conversation. */
export type ConversationStateTag = (typeof ConversationStateTag)[keyof typeof ConversationStateTag];

/** Enumerates the control-transport connection states. */
export const TransportStatus = {
  Idle: "idle",
  Connecting: "connecting",
  Connected: "connected",
  Reconnecting: "reconnecting",
  Closed: "closed",
  Failed: "failed",
} as const;
/** A control-transport connection state. */
export type TransportStatus = (typeof TransportStatus)[keyof typeof TransportStatus];

/** Enumerates the recording artifact states. */
export const ArtifactStatus = {
  Pending: "pending",
  Recording: "recording",
  Uploading: "uploading",
  Ready: "ready",
  Failed: "failed",
} as const;
/** A recording artifact state. */
export type ArtifactStatus = (typeof ArtifactStatus)[keyof typeof ArtifactStatus];

/** Enumerates the normal reasons a conversation can end. */
export const StopReason = {
  UserRequested: "user_requested",
  TimeLimitReached: "time_limit_reached",
} as const;
/** A normal conversation termination reason. */
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

/** Enumerates the lifecycle phase in which a conversation failed. */
export const FailureStage = {
  Starting: "starting",
  Transport: "transport",
  Artifact: "artifact",
  Ending: "ending",
} as const;
/** The lifecycle phase in which a conversation failed. */
export type FailureStage = (typeof FailureStage)[keyof typeof FailureStage];

/** Validates finite, non-negative integer fields. */
const finiteInt = z.number().int().nonnegative().finite();
/** Validates positive, finite epoch numbers. */
const positiveEpoch = z.number().int().positive().finite();
/** Validates bounded machine-readable error codes. */
const errorCode = z.string().min(1).max(128);

/** Validates the state of a conversation's control transport. */
export const transportStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal(TransportStatus.Idle) }),
  z.object({ status: z.literal(TransportStatus.Connecting), epoch: positiveEpoch }),
  z.object({ status: z.literal(TransportStatus.Connected), epoch: positiveEpoch }),
  z.object({
    status: z.literal(TransportStatus.Reconnecting),
    epoch: positiveEpoch,
    attempt: positiveEpoch,
    lastErrorCode: errorCode,
  }),
  z.object({ status: z.literal(TransportStatus.Closed), epoch: positiveEpoch }),
  z.object({ status: z.literal(TransportStatus.Failed), epoch: finiteInt, errorCode }),
]);

/** Validates the state of a conversation's recording artifact. */
export const artifactStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal(ArtifactStatus.Pending) }),
  z.object({ status: z.literal(ArtifactStatus.Recording) }),
  z.object({ status: z.literal(ArtifactStatus.Uploading) }),
  z.object({ status: z.literal(ArtifactStatus.Ready) }),
  z.object({ status: z.literal(ArtifactStatus.Failed), errorCode }),
]);

/** Validates the complete browser-facing conversation state DTO. */
export const conversationStateSchema = z.looseObject({
  conversationId: z.string().min(1).max(128),
  state: z.enum(ConversationStateTag),
  revision: finiteInt,
  enteredAt: finiteInt,
  updatedAt: finiteInt,
  activeDeadlineAt: finiteInt.nullable(),
  transport: transportStateSchema,
  artifact: artifactStateSchema,
  starting: z.object({ startDeadlineAt: finiteInt }).optional(),
  live: z.object({ startedAt: finiteInt, maximumEndAt: finiteInt }).optional(),
  ending: z.object({ target: z.enum(["complete", "cancel", "fail"]) }).optional(),
  completed: z.object({ completedAt: finiteInt, terminationReason: z.enum(StopReason) }).optional(),
  cancelled: z.object({ cancelledAt: finiteInt, reason: z.string() }).optional(),
  failed: z.object({ failedAt: finiteInt, stage: z.enum(FailureStage), errorCode }).optional(),
});

/** Browser-facing state for the control transport. */
export type TransportStateDto = z.infer<typeof transportStateSchema>;
/** Browser-facing state for the recording artifact. */
export type ArtifactStateDto = z.infer<typeof artifactStateSchema>;
/** Browser-facing state snapshot for a conversation. */
export type ConversationStateDto = z.infer<typeof conversationStateSchema>;
