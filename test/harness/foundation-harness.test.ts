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
});
