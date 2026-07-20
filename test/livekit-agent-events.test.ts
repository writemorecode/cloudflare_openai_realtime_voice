import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  ConversationEventType,
  ConversationStateTag,
  TransportStatus,
  value,
} from "../src/domain/conversation-state-machine";
import { authenticatedHeaders } from "./auth-helpers";

const API_ORIGIN = "https://api.example.test";
const BROWSER_ORIGIN = "http://localhost:5173";
const AGENT_TOKEN = "test-agent-callback-token";

async function createProvisionedConversation(key: string): Promise<string> {
  const created = await exports.default.fetch(
    new Request(`${API_ORIGIN}/v1/conversations`, {
      method: "POST",
      headers: await authenticatedHeaders({ Origin: BROWSER_ORIGIN, "Idempotency-Key": key }),
    }),
  );
  const { conversationId } = await created.json<{ conversationId: string }>();
  await exports.default.fetch(
    new Request(`${API_ORIGIN}/v1/conversations/${conversationId}/start`, {
      method: "POST",
      headers: await authenticatedHeaders({ Origin: BROWSER_ORIGIN }),
    }),
  );
  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  const roomName = `conversation-${conversationId}`;
  const claim = await stub.beginLiveKitProvisioning({
    roomName,
    transportEpoch: 1,
    leaseId: "test-lease",
    now: Date.now(),
    leaseExpiresAt: Date.now() + 10_000,
  });
  expect(claim.outcome).toBe("owner");
  expect(
    await stub.completeLiveKitProvisioning({
      status: "ready",
      roomName,
      transportEpoch: 1,
      dispatchId: "AD_test",
      egressId: "EG_test",
      expectedR2Key: `conversations/${conversationId}/recording.ogg`,
      leaseId: "test-lease",
    }),
  ).toBe(true);
  return conversationId;
}

function agentEvent(
  conversationId: string,
  type:
    | "realtime_ready"
    | "realtime_interrupted"
    | "realtime_recovered"
    | "realtime_failed"
    | "session_closed",
  suffix: string,
  transportEpoch = 1,
): Record<string, unknown> {
  return {
    version: 1,
    type,
    eventId: `agent:${conversationId}:${transportEpoch}:${suffix}`,
    conversationId,
    roomName: `conversation-${conversationId}`,
    transportEpoch,
    occurredAt: new Date().toISOString(),
    ...(type === "realtime_failed" ? { errorCode: "transport.agent_realtime_failed" } : {}),
  };
}

async function makeConversationLive(conversationId: string): Promise<void> {
  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  const roomName = `conversation-${conversationId}`;
  const observations = [
    ["browser_participant_joined", `browser-${conversationId}`],
    ["browser_audio_published", `browser-${conversationId}`],
    ["agent_participant_joined", "agent-test"],
    ["agent_audio_published", "agent-test"],
  ] as const;
  for (const [kind, participantIdentity] of observations) {
    expect(
      // oxlint-disable-next-line no-await-in-loop -- Each observation advances the durable-object state for the next one.
      await stub.recordLiveKitMediaObservation({
        eventId: crypto.randomUUID(),
        kind,
        participantIdentity,
        roomName,
        transportEpoch: 1,
      }),
    ).toBe("recorded");
  }
  expect(
    (await postAgentEvent(agentEvent(conversationId, "realtime_ready", "realtime-ready"))).status,
  ).toBe(204);
  const state = await stub.getState();
  expect(state).not.toBeNull();
  const recording = await stub.applyIntegrationEvent({
    expectedRevision: state!.revision,
    event: {
      type: ConversationEventType.RecordingStarted,
      eventId: `test:${conversationId}:recording-started`,
      at: value.unixMillis(Date.now()),
      recordingId: value.recordingId("EG_test"),
    },
  });
  expect(recording.outcome).toBe("applied");
  const started = await stub.applyIntegrationEvent({
    expectedRevision: recording.state!.revision,
    event: {
      type: ConversationEventType.SessionStarted,
      eventId: `test:${conversationId}:session-started`,
      at: value.unixMillis(Date.now()),
      epoch: 1,
      maximumEndAt: value.unixMillis(Date.now() + 60_000),
    },
  });
  expect(started.outcome).toBe("applied");
}

async function postAgentEvent(payload: Record<string, unknown>, token = AGENT_TOKEN) {
  return exports.default.fetch(
    new Request(`${API_ORIGIN}/v1/integrations/livekit/agent-events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

describe("LiveKit agent lifecycle events", () => {
  it("authenticates, correlates, and deduplicates realtime readiness evidence", async () => {
    const conversationId = await createProvisionedConversation("agent-ready-event");
    const payload = agentEvent(conversationId, "realtime_ready", "realtime-ready");

    const unauthorized = await postAgentEvent(payload, "wrong-token");
    const first = await postAgentEvent(payload);
    const duplicate = await postAgentEvent(payload);
    const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);

    expect(unauthorized.status).toBe(401);
    expect(first.status).toBe(204);
    expect(duplicate.status).toBe(204);
    expect(await stub.getLiveKitTransportEvidence()).toMatchObject({
      transportEpoch: 1,
      realtimeReady: true,
      realtimeReadyEventId: payload.eventId,
    });
    expect((await stub.getState())?.revision).toBe(1);
  });

  it("maps fatal agent failures without exposing provider details", async () => {
    const conversationId = await createProvisionedConversation("agent-failed-event");
    const response = await postAgentEvent(
      agentEvent(conversationId, "realtime_failed", "realtime-failed"),
    );
    const state = await env.CONVERSATION_SESSIONS.getByName(conversationId).getState();

    expect(response.status).toBe(204);
    expect(state).toMatchObject({
      tag: ConversationStateTag.Failed,
      data: { errorCode: "transport.agent_realtime_failed" },
    });
  });

  it("maps Realtime interruption and recovery to the next transport epoch", async () => {
    const conversationId = await createProvisionedConversation("agent-recovery-events");
    await makeConversationLive(conversationId);

    const interrupted = await postAgentEvent(
      agentEvent(conversationId, "realtime_interrupted", "realtime-interrupted"),
    );
    let state = await env.CONVERSATION_SESSIONS.getByName(conversationId).getState();
    expect(interrupted.status).toBe(204);
    expect(state).toMatchObject({
      tag: ConversationStateTag.Live,
      data: { transport: { status: TransportStatus.Reconnecting, epoch: 1 } },
    });

    const recoveredPayload = agentEvent(
      conversationId,
      "realtime_recovered",
      "realtime-recovered",
      2,
    );
    const recovered = await postAgentEvent(recoveredPayload);
    const duplicate = await postAgentEvent(recoveredPayload);
    const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
    state = await stub.getState();

    expect(recovered.status).toBe(204);
    expect(duplicate.status).toBe(204);
    expect(state).toMatchObject({
      tag: ConversationStateTag.Live,
      data: { transport: { status: TransportStatus.Connected, epoch: 2 } },
    });
    expect(await stub.getLiveKitTransportEvidence()).toMatchObject({
      transportEpoch: 2,
      realtimeReady: true,
      realtimeReadyEventId: recoveredPayload.eventId,
    });
  });

  it("rejects room and epoch correlation mismatches", async () => {
    const conversationId = await createProvisionedConversation("agent-mismatch-event");
    const payload = agentEvent(conversationId, "realtime_ready", "realtime-ready");
    payload.roomName = "conversation-e570d451-98dc-4ba8-867b-735c652114b7";
    const response = await postAgentEvent(payload);

    expect(response.status).toBe(400);
  });
});
