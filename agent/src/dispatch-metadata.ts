/** Encodes, validates, and creates the versioned metadata attached to agent dispatches. */
import { randomUUID } from "node:crypto";

import { z } from "zod";

export interface AgentDispatchMetadataV1 {
  readonly version: 1;
  readonly conversationId: string;
  readonly roomName: `conversation-${string}`;
  readonly transportEpoch: number;
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

export function parseDispatchMetadata(serialized: string): AgentDispatchMetadataV1 {
  try {
    const parsed: unknown = JSON.parse(serialized);
    const result = dispatchMetadataSchema.safeParse(parsed);
    if (!result.success) throw new Error("schema mismatch");
    return {
      version: 1,
      conversationId: result.data.conversationId,
      roomName: result.data.roomName as `conversation-${string}`,
      transportEpoch: result.data.transportEpoch,
    };
  } catch {
    throw new Error("Invalid agent dispatch metadata");
  }
}

export function dispatchMetadataForJob(
  ctx: AgentJobContext,
  allowSyntheticMetadata: boolean,
): AgentDispatchMetadataV1 {
  if (ctx.isFakeJob && allowSyntheticMetadata) return syntheticDispatchMetadata();

  const metadata = parseDispatchMetadata(ctx.job.metadata);
  // The assigned room is available on the job descriptor before connect() populates the RTC room.
  if (!ctx.isFakeJob && ctx.job.room?.name !== metadata.roomName) {
    throw new Error("Agent dispatch room does not match the assigned room");
  }
  return metadata;
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
