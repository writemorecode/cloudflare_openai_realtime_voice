import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { ConversationStateTag, TransportStatus } from "../src/domain/conversation-state-machine";
import { FoundationHarness } from "./harness/foundation-harness";

async function createProvisionedConversation(
  harness: FoundationHarness,
  key: string,
): Promise<string> {
  const starting = await harness.createStartedConversation(key);
  await harness.provisionConversation(starting.conversationId);
  return starting.conversationId;
}

describe("LiveKit agent lifecycle events", () => {
  it("returns a retryable response until provisioning correlation exists", async () => {
    const harness = new FoundationHarness(env);
    const starting = await harness.createStartedConversation("agent-event-before-provisioning");
    const response = await harness.agentEvent(starting.conversationId, "realtime_ready");

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
  });

  it("authenticates, correlates, and deduplicates realtime readiness evidence", async () => {
    const harness = new FoundationHarness(env);
    const conversationId = await createProvisionedConversation(harness, "agent-ready-event");
    const eventId = `agent:${conversationId}:1:realtime-ready`;

    const unauthorized = await harness.agentEvent(conversationId, "realtime_ready", {
      eventId,
      token: "wrong-token",
    });
    const first = await harness.agentEvent(conversationId, "realtime_ready", { eventId });
    const duplicate = await harness.agentEvent(conversationId, "realtime_ready", { eventId });

    expect(unauthorized.status).toBe(401);
    expect(first.status).toBe(204);
    expect(duplicate.status).toBe(204);
    expect(await harness.session(conversationId).getLiveKitTransportEvidence()).toMatchObject({
      transportEpoch: 1,
      realtimeReady: true,
      realtimeReadyEventId: eventId,
    });
    expect((await harness.state(conversationId))?.revision).toBe(1);
  });

  it("maps fatal agent failures without exposing provider details", async () => {
    const harness = new FoundationHarness(env);
    const conversationId = await createProvisionedConversation(harness, "agent-failed-event");
    const response = await harness.agentEvent(conversationId, "realtime_failed");

    expect(response.status).toBe(204);
    expect(await harness.state(conversationId)).toMatchObject({
      tag: ConversationStateTag.Failed,
      data: { errorCode: "transport.agent_realtime_failed" },
    });
  });

  it("maps Realtime interruption and recovery to the next transport epoch", async () => {
    const harness = new FoundationHarness(env);
    const conversationId = await createProvisionedConversation(harness, "agent-recovery-events");
    await harness.reachLive(conversationId);

    const interrupted = await harness.agentEvent(conversationId, "realtime_interrupted");
    expect(interrupted.status).toBe(204);
    expect(await harness.state(conversationId)).toMatchObject({
      tag: ConversationStateTag.Live,
      data: { transport: { status: TransportStatus.Reconnecting, epoch: 1 } },
    });

    const eventId = `agent:${conversationId}:2:realtime-recovered`;
    const recovered = await harness.agentEvent(conversationId, "realtime_recovered", {
      transportEpoch: 2,
      eventId,
    });
    const duplicate = await harness.agentEvent(conversationId, "realtime_recovered", {
      transportEpoch: 2,
      eventId,
    });

    expect(recovered.status).toBe(204);
    expect(duplicate.status).toBe(204);
    expect(await harness.state(conversationId)).toMatchObject({
      tag: ConversationStateTag.Live,
      data: { transport: { status: TransportStatus.Connected, epoch: 2 } },
    });
    expect(await harness.session(conversationId).getLiveKitTransportEvidence()).toMatchObject({
      transportEpoch: 2,
      realtimeReady: true,
      realtimeReadyEventId: eventId,
    });
  });

  it("rejects room and epoch correlation mismatches", async () => {
    const harness = new FoundationHarness(env);
    const conversationId = await createProvisionedConversation(harness, "agent-mismatch-event");
    const wrongRoom = await harness.agentEvent(conversationId, "realtime_ready", {
      roomName: "conversation-e570d451-98dc-4ba8-867b-735c652114b7",
    });
    const wrongEpoch = await harness.agentEvent(conversationId, "realtime_ready", {
      transportEpoch: 2,
    });

    expect(wrongRoom.status).toBe(400);
    expect(wrongEpoch.status).toBe(409);
  });
});
