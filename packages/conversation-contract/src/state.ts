/** Stable, provider-neutral state exposed to browser applications. */
import { z } from "zod";

export const ConversationStateTag = {
  Created: "created",
  Starting: "starting",
  Live: "live",
  Ending: "ending",
  Completed: "completed",
  Cancelled: "cancelled",
  Failed: "failed",
} as const;
export type ConversationStateTag = (typeof ConversationStateTag)[keyof typeof ConversationStateTag];

export const TransportStatus = {
  Idle: "idle",
  Connecting: "connecting",
  Connected: "connected",
  Reconnecting: "reconnecting",
  Closed: "closed",
  Failed: "failed",
} as const;
export type TransportStatus = (typeof TransportStatus)[keyof typeof TransportStatus];

export const ArtifactStatus = {
  Pending: "pending",
  Recording: "recording",
  Uploading: "uploading",
  Ready: "ready",
  Failed: "failed",
} as const;
export type ArtifactStatus = (typeof ArtifactStatus)[keyof typeof ArtifactStatus];

export const StopReason = {
  UserRequested: "user_requested",
  TimeLimitReached: "time_limit_reached",
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

export const FailureStage = {
  Starting: "starting",
  Transport: "transport",
  Artifact: "artifact",
  Ending: "ending",
} as const;
export type FailureStage = (typeof FailureStage)[keyof typeof FailureStage];

const finiteInt = z.number().int().nonnegative().finite();
const positiveEpoch = z.number().int().positive().finite();
const errorCode = z.string().min(1).max(128);

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

export const artifactStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal(ArtifactStatus.Pending) }),
  z.object({ status: z.literal(ArtifactStatus.Recording) }),
  z.object({ status: z.literal(ArtifactStatus.Uploading) }),
  z.object({ status: z.literal(ArtifactStatus.Ready) }),
  z.object({ status: z.literal(ArtifactStatus.Failed), errorCode }),
]);

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

export type TransportStateDto = z.infer<typeof transportStateSchema>;
export type ArtifactStateDto = z.infer<typeof artifactStateSchema>;
export type ConversationStateDto = z.infer<typeof conversationStateSchema>;
