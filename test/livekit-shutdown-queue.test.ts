import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/worker/http/api-errors";
import {
  LIVEKIT_SHUTDOWN_MESSAGE_VERSION,
  type LiveKitShutdownMessage,
} from "../src/shared/livekit-shutdown";
import { handleLiveKitShutdownBatch } from "../src/worker/integrations/livekit/shutdown-queue";

const CONVERSATION_ID = "12345678-1234-8234-9234-123456789abc";

function batch(body: LiveKitShutdownMessage, attempts = 1) {
  return createMessageBatch<LiveKitShutdownMessage>("oral-exam-livekit-shutdown", [
    { id: crypto.randomUUID(), timestamp: new Date(), attempts, body },
  ]);
}

function message(): LiveKitShutdownMessage {
  return {
    version: LIVEKIT_SHUTDOWN_MESSAGE_VERSION,
    conversationId: CONVERSATION_ID,
    triggerEventId: "system:alarm:time-limit:test",
  };
}

describe("LiveKit shutdown queue", () => {
  it("acknowledges successful idempotent teardown", async () => {
    const messages = batch(message());
    const stop = vi.fn().mockResolvedValue("stopped");

    await handleLiveKitShutdownBatch(messages, env, stop);
    const result = await getQueueResult(messages, createExecutionContext());

    expect(stop).toHaveBeenCalledWith(env, CONVERSATION_ID);
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toHaveLength(0);
  });

  it("retries transient provider failures", async () => {
    const messages = batch(message(), 2);
    const stop = vi.fn().mockRejectedValue(new Error("temporary LiveKit failure"));

    await handleLiveKitShutdownBatch(messages, env, stop);
    const result = await getQueueResult(messages, createExecutionContext());

    expect(result.explicitAcks).toHaveLength(0);
    expect(result.retryMessages).toHaveLength(1);
  });

  it("acknowledges conversations with no provisioned resources", async () => {
    const messages = batch(message());
    const stop = vi
      .fn()
      .mockRejectedValue(
        new ApiError(409, "livekit_not_provisioned", "LiveKit resources cannot be stopped."),
      );

    await handleLiveKitShutdownBatch(messages, env, stop);
    const result = await getQueueResult(messages, createExecutionContext());

    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toHaveLength(0);
  });

  it("drops malformed messages instead of retrying them forever", async () => {
    const messages = batch({ ...message(), conversationId: "not-a-conversation-id" });
    const stop = vi.fn();

    await handleLiveKitShutdownBatch(messages, env, stop);
    const result = await getQueueResult(messages, createExecutionContext());

    expect(stop).not.toHaveBeenCalled();
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toHaveLength(0);
  });
});
