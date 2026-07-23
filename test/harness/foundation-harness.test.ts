import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { FoundationHarness } from "./foundation-harness";

describe("deterministic foundation harness", () => {
  it("uses fixed time, repeatable IDs, real Durable Object state, and in-memory providers", async () => {
    const harness = new FoundationHarness(env, { now: 1_800_000_000_000 });
    const starting = await harness.createStartedConversation("harness-determinism");
    const access = await harness.provisionConversation(starting.conversationId);

    expect(starting).toMatchObject({
      state: "starting",
      enteredAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    });
    expect(access).toEqual({
      roomName: harness.roomName(starting.conversationId),
      serverUrl: "wss://test.livekit.cloud",
      participantToken: `harness-token:${harness.roomName(starting.conversationId)}:browser-${starting.conversationId}`,
    });
    expect(await harness.state(starting.conversationId)).toMatchObject({
      tag: "starting",
      revision: 1,
      data: { transport: { status: "connecting", epoch: 1 } },
    });
    expect(harness.liveKit.count("create_room")).toBe(1);
    expect(harness.liveKit.count("create_dispatch")).toBe(1);
    expect(harness.liveKit.count("start_egress")).toBe(1);
  });

  it("injects provider failures and converges through the real retry-safe provisioning path", async () => {
    const harness = new FoundationHarness(env);
    const starting = await harness.createStartedConversation("harness-provider-retry");
    harness.liveKit.failNext("start_egress");

    const failed = await harness.browserRequest(
      `/v1/conversations/${starting.conversationId}/livekit-access`,
      { method: "POST" },
    );
    const recovered = await harness.provisionConversation(starting.conversationId);

    expect(failed.status).toBe(502);
    expect(recovered.roomName).toBe(harness.roomName(starting.conversationId));
    expect(harness.liveKit.count("create_room")).toBe(1);
    expect(harness.liveKit.count("create_dispatch")).toBe(1);
    expect(harness.liveKit.count("start_egress")).toBe(2);
  });

  it("drives a successful foundation lifecycle with exact, inspectable outcomes", async () => {
    const now = 4_200_000_000_000;
    const harness = new FoundationHarness(env, { now });
    const starting = await harness.createStartedConversation("harness-successful-lifecycle");
    const conversationId = starting.conversationId;

    await harness.provisionConversation(conversationId);
    await harness.reachLive(conversationId);

    expect(await harness.state(conversationId)).toMatchObject({
      tag: "live",
      revision: 4,
      enteredAt: now,
      updatedAt: now,
      data: {
        transport: { status: "connected", epoch: 1 },
        artifact: { status: "recording" },
        startedAt: now,
      },
    });

    harness.clock.advance(1_000);
    await harness.beginEnding(conversationId);
    expect((await harness.stopConversationResources(conversationId)).status).toBe(204);

    harness.clock.advance(1_000);
    const recording = await harness.completeRecording(conversationId, {
      etag: "etag-exact",
      size: 4,
    });
    harness.clock.advance(1_000);
    await harness.closeRoom(conversationId);

    expect(await harness.state(conversationId)).toMatchObject({
      tag: "completed",
      revision: 8,
      enteredAt: now + 3_000,
      updatedAt: now + 3_000,
      data: {
        transport: { status: "closed", epoch: 1 },
        artifact: {
          status: "ready",
          r2Key: recording.objectKey,
          r2Etag: recording.etag,
        },
        completedAt: now + 3_000,
        terminationReason: "user_requested",
      },
    });
    expect(await harness.getConversation(conversationId)).toMatchObject({
      state: "completed",
      revision: 8,
      transport: { status: "closed", epoch: 1 },
      artifact: { status: "ready" },
      completed: {
        completedAt: now + 3_000,
        terminationReason: "user_requested",
      },
    });
    expect(harness.recordings.headCalls).toEqual([recording.objectKey]);
    expect(harness.liveKit.count("stop_egress")).toBe(1);
    expect(harness.liveKit.count("delete_dispatch")).toBe(1);
    expect(harness.liveKit.count("delete_room")).toBe(1);
  });
});
