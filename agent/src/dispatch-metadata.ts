/** Encodes, validates, and creates the versioned metadata attached to agent dispatches. */
import { randomUUID } from "node:crypto";

import { Result } from "better-result";
import { z } from "zod";

export interface AgentDispatchMetadataV1 {
  readonly version: 1;
  readonly conversationId: string;
  readonly roomName: `conversation-${string}`;
  readonly transportEpoch: number;
}

export interface AgentDispatchMetadataError {
  readonly code: "invalid_metadata" | "room_mismatch";
  readonly message: string;
  readonly cause?: unknown;
}

interface AgentJobContext {
  readonly isFakeJob: boolean;
  readonly job: {
    readonly metadata: string;
    readonly room?: { readonly name: string } | undefined;
  };
  readonly room: { readonly name: string | undefined };
}

const dispatchMetadataSchema = z
  .object({
    version: z.literal(1),
    conversationId: z.uuid(),
    roomName: z.string().startsWith("conversation-"),
    transportEpoch: z.int().positive(),
  })
  .strict()
  .refine((metadata) => metadata.roomName === `conversation-${metadata.conversationId}`, {
    message: "Room name does not match the conversation ID",
    path: ["roomName"],
  });

export function parseDispatchMetadata(
  serialized: string,
): Result<AgentDispatchMetadataV1, AgentDispatchMetadataError> {
  const parsed: Result<unknown, AgentDispatchMetadataError> = Result.try({
    try: () => JSON.parse(serialized) as unknown,
    catch: (cause) => ({
      code: "invalid_metadata" as const,
      message: "Invalid agent dispatch metadata",
      cause,
    }),
  });
  if (!Result.isOk(parsed)) return parsed;
  const result = dispatchMetadataSchema.safeParse(parsed.value);
  if (!result.success) {
    return Result.err({ code: "invalid_metadata", message: "Invalid agent dispatch metadata" });
  }
  return Result.ok({
    version: 1,
    conversationId: result.data.conversationId,
    roomName: result.data.roomName as `conversation-${string}`,
    transportEpoch: result.data.transportEpoch,
  });
}

export function dispatchMetadataForJob(
  ctx: AgentJobContext,
  allowSyntheticMetadata: boolean,
): Result<AgentDispatchMetadataV1, AgentDispatchMetadataError> {
  if (ctx.isFakeJob && allowSyntheticMetadata) return Result.ok(syntheticDispatchMetadata());

  const metadata = parseDispatchMetadata(ctx.job.metadata);
  if (!Result.isOk(metadata)) return metadata;
  // The assigned room is available on the job descriptor before connect() populates the RTC room.
  if (!ctx.isFakeJob && ctx.job.room?.name !== metadata.value.roomName) {
    return Result.err({
      code: "room_mismatch",
      message: "Agent dispatch room does not match the assigned room",
    });
  }
  return Result.ok(metadata.value);
}

export function syntheticDispatchMetadata(): AgentDispatchMetadataV1 {
  const conversationId = randomUUID();
  return {
    version: 1,
    conversationId,
    roomName: `conversation-${conversationId}`,
    transportEpoch: 1,
  };
}
