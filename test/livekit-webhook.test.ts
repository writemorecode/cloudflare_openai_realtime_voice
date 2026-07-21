import { AccessToken } from "livekit-server-sdk";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  ConversationEventType,
  ConversationStateTag,
  value,
  type ConversationState,
} from "../src/domain/conversation-state-machine";
import { authenticatedHeaders } from "./auth-helpers";

const API_ORIGIN = "https://api.example.test";
const BROWSER_ORIGIN = "http://localhost:5173";
const LIVEKIT_API_KEY = "test-livekit-api-key";
const LIVEKIT_API_SECRET = "test-livekit-api-secret-with-sufficient-entropy";

async function createStartedConversation(key: string): Promise<string> {
  const conversationId = await createUnprovisionedStartedConversation(key);
  await provisionConversation(conversationId);
  return conversationId;
}

async function createUnprovisionedStartedConversation(key: string): Promise<string> {
  const created = await exports.default.fetch(
    new Request(`${API_ORIGIN}/v1/conversations`, {
      method: "POST",
      headers: await authenticatedHeaders({ Origin: BROWSER_ORIGIN, "Idempotency-Key": key }),
    }),
  );
  const body = await created.json<{ conversationId: string }>();
  const started = await exports.default.fetch(
    new Request(`${API_ORIGIN}/v1/conversations/${body.conversationId}/start`, {
      method: "POST",
      headers: await authenticatedHeaders({ Origin: BROWSER_ORIGIN }),
    }),
  );
  expect(started.status).toBe(202);
  return body.conversationId;
}

async function provisionConversation(conversationId: string): Promise<void> {
  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  const roomName = `conversation-${conversationId}`;
  const claim = await stub.beginLiveKitProvisioning({
    roomName,
    transportEpoch: 1,
    leaseId: "webhook-test-lease",
    now: Date.now(),
    leaseExpiresAt: Date.now() + 10_000,
  });
  expect(claim.outcome).toBe("owner");
  expect(
    await stub.completeLiveKitProvisioning({
      status: "ready",
      roomName,
      transportEpoch: 1,
      dispatchId: "AD_webhook_test",
      egressId: `EG_${conversationId}`,
      expectedR2Key: `conversations/${conversationId}/recording.ogg`,
      leaseId: "webhook-test-lease",
    }),
  ).toBe(true);
}

async function webhookRequest(
  payload: Record<string, unknown>,
  options: {
    readonly body?: string;
    readonly tokenForBody?: string;
    readonly contentType?: string;
  } = {},
): Promise<Response> {
  const body = options.body ?? JSON.stringify(payload);
  const tokenBody = options.tokenForBody ?? body;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenBody)),
  );
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  token.sha256 = btoa(String.fromCharCode(...digest));
  return exports.default.fetch(
    new Request(`${API_ORIGIN}/v1/integrations/livekit/webhook`, {
      method: "POST",
      headers: {
        Authorization: await token.toJwt(),
        "Content-Type": options.contentType ?? "application/webhook+json",
      },
      body,
    }),
  );
}

function egressEvent(
  event: "egress_started" | "egress_updated" | "egress_ended",
  eventId: string,
  conversationId: string,
  status: string,
  fileResults: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    event,
    id: eventId,
    createdAt: String(Math.floor(Date.now() / 1000)),
    egressInfo: {
      egressId: `EG_${conversationId}`,
      roomName: `conversation-${conversationId}`,
      status,
      fileResults,
    },
  };
}

describe("LiveKit webhook", () => {
  it("returns a retryable response until provisioning correlation exists", async () => {
    const conversationId = await createUnprovisionedStartedConversation(
      "livekit-webhook-before-provisioning",
    );
    const response = await webhookRequest({
      event: "participant_joined",
      id: "EV_22222222222A",
      createdAt: String(Math.floor(Date.now() / 1000)),
      room: { name: `conversation-${conversationId}` },
      participant: { identity: `browser-${conversationId}`, kind: "STANDARD" },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
  });

  it("requires LiveKit signature verification and the webhook media type", async () => {
    const missingSignature = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/integrations/livekit/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/webhook+json" },
        body: "{}",
      }),
    );
    const wrongMediaType = await webhookRequest(
      { event: "room_started" },
      { contentType: "application/json" },
    );
    const tampered = await webhookRequest(
      { event: "room_started" },
      {
        body: JSON.stringify({ event: "room_finished" }),
        tokenForBody: JSON.stringify({ event: "room_started" }),
      },
    );

    expect(missingSignature.status).toBe(401);
    expect(wrongMediaType.status).toBe(415);
    expect(tampered.status).toBe(401);
  });

  it("accepts current LiveKit event IDs but rejects malformed IDs", async () => {
    const conversationId = await createStartedConversation("livekit-event-id-format");
    const payload = {
      event: "participant_joined",
      id: "EV_22222222222B",
      createdAt: String(Math.floor(Date.now() / 1000)),
      room: { name: `conversation-${conversationId}` },
      participant: { identity: `browser-${conversationId}`, kind: "STANDARD" },
    };

    expect((await webhookRequest(payload)).status).toBe(204);
    expect((await webhookRequest({ ...payload, id: "EV_too-short" })).status).toBe(400);
  });

  it("records active egress exactly once across webhook retries", async () => {
    const conversationId = await createStartedConversation("livekit-egress-started");
    const payload = egressEvent(
      "egress_started",
      "EV_22222222222C",
      conversationId,
      "EGRESS_ACTIVE",
    );

    const first = await webhookRequest(payload);
    const duplicate = await webhookRequest(payload);
    const state = await env.CONVERSATION_SESSIONS.getByName(conversationId).getState();

    expect(first.status).toBe(204);
    expect(duplicate.status).toBe(204);
    expect(state).toMatchObject({
      tag: ConversationStateTag.Starting,
      revision: 2,
      data: { artifact: { status: "recording" } },
    });
  });

  it("requires browser, agent, both audio tracks, Realtime, and recording before going live", async () => {
    const conversationId = await createStartedConversation("livekit-composite-readiness");
    const room = { name: `conversation-${conversationId}` };
    const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);

    await webhookRequest(
      egressEvent("egress_started", "EV_22222222222D", conversationId, "EGRESS_ACTIVE"),
    );
    const ready = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/integrations/livekit/agent-events`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-agent-callback-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          version: 1,
          type: "realtime_ready",
          eventId: `agent:${conversationId}:1:realtime-ready`,
          conversationId,
          roomName: room.name,
          transportEpoch: 1,
          occurredAt: new Date().toISOString(),
        }),
      }),
    );
    expect(ready.status).toBe(204);

    const observations = [
      {
        event: "participant_joined",
        id: "EV_22222222222E",
        room,
        participant: { identity: `browser-${conversationId}`, kind: "STANDARD" },
      },
      {
        event: "track_published",
        id: "EV_22222222222F",
        room,
        // LiveKit track webhooks intentionally omit participant.kind.
        participant: { identity: `browser-${conversationId}` },
        track: { sid: "TR_browser", type: "AUDIO", source: "MICROPHONE" },
      },
      {
        event: "participant_joined",
        id: "EV_22222222222G",
        room,
        participant: { identity: "agent-runtime-identity", kind: "AGENT" },
      },
      {
        event: "track_published",
        id: "EV_22222222222H",
        room,
        // Agent identity must be correlated with the preceding participant_joined event.
        participant: { identity: "agent-runtime-identity" },
        track: { sid: "TR_agent", type: "AUDIO", source: "MICROPHONE" },
      },
    ] as const;

    const assertObservation = async (
      observation: (typeof observations)[number],
      expectedState: ConversationStateTag,
    ): Promise<void> => {
      const response = await webhookRequest({
        ...observation,
        createdAt: String(Math.floor(Date.now() / 1000)),
      });
      expect(response.status).toBe(204);
      const state = await stub.getState();
      expect(state?.tag).toBe(expectedState);
    };
    await assertObservation(observations[0], ConversationStateTag.Starting);
    await assertObservation(observations[1], ConversationStateTag.Starting);
    await assertObservation(observations[2], ConversationStateTag.Starting);
    await assertObservation(observations[3], ConversationStateTag.Live);

    expect(await stub.getState()).toMatchObject({
      tag: ConversationStateTag.Live,
      revision: 4,
      data: {
        transport: { status: "connected", epoch: 1 },
        artifact: { status: "recording" },
      },
    });

    const interrupted = await webhookRequest({
      event: "track_unpublished",
      id: "EV_22222222222J",
      createdAt: String(Math.floor(Date.now() / 1000)),
      room,
      participant: { identity: `browser-${conversationId}`, kind: "STANDARD" },
      track: { sid: "TR_browser", type: "AUDIO", source: "MICROPHONE" },
    });
    expect(interrupted.status).toBe(204);
    expect(await stub.getState()).toMatchObject({
      tag: ConversationStateTag.Live,
      revision: 5,
      data: { transport: { status: "reconnecting", epoch: 1 } },
    });
  });

  it("maps failed egress to a sanitized artifact failure", async () => {
    const conversationId = await createStartedConversation("livekit-egress-failed");
    const response = await webhookRequest(
      egressEvent("egress_ended", "EV_22222222222K", conversationId, "EGRESS_FAILED"),
    );
    const state = await env.CONVERSATION_SESSIONS.getByName(conversationId).getState();

    expect(response.status).toBe(204);
    expect(state).toMatchObject({
      tag: ConversationStateTag.Ending,
      data: {
        artifact: {
          status: "failed",
          errorCode: "artifact.livekit_egress_failed",
        },
        target: {
          kind: "fail",
          errorCode: "artifact.livekit_egress_failed",
        },
      },
    });
  });

  it("rejects egress events that do not match the provisioned recording", async () => {
    const conversationId = await createStartedConversation("livekit-egress-mismatch");
    const payload = egressEvent(
      "egress_started",
      "EV_22222222222M",
      conversationId,
      "EGRESS_ACTIVE",
    );
    const egressInfo = payload.egressInfo as Record<string, unknown>;
    egressInfo.egressId = "EG_unrelated";

    const response = await webhookRequest(payload);
    const state = await env.CONVERSATION_SESSIONS.getByName(conversationId).getState();

    expect(response.status).toBe(409);
    expect(state).toMatchObject({
      tag: ConversationStateTag.Starting,
      revision: 1,
      data: { artifact: { status: "pending" } },
    });
  });

  it("verifies the R2 recording and completes after the room closes", async () => {
    const conversationId = await createStartedConversation("livekit-completion");
    const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
    const startedEgress = await webhookRequest(
      egressEvent("egress_started", "EV_22222222222N", conversationId, "EGRESS_ACTIVE"),
    );
    expect(startedEgress.status).toBe(204);

    let state: ConversationState | null = await stub.getState();
    expect(state).not.toBeNull();
    let applied = await stub.applyEvent({
      expectedRevision: state!.revision,
      event: {
        type: ConversationEventType.TransportConnected,
        eventId: "test:transport-connected",
        at: value.unixMillis(Date.now()),
        epoch: 1,
      },
    });
    expect(applied.outcome).toBe("applied");
    state = applied.state;
    applied = await stub.applyEvent({
      expectedRevision: state!.revision,
      event: {
        type: ConversationEventType.SessionStarted,
        eventId: "test:session-started",
        at: value.unixMillis(Date.now()),
        epoch: 1,
        maximumEndAt: value.unixMillis(Date.now() + 60_000),
      },
    });
    expect(applied.outcome).toBe("applied");
    state = applied.state;
    applied = await stub.applyEvent({
      expectedRevision: state!.revision,
      event: {
        type: ConversationEventType.EndRequested,
        eventId: "test:end-requested",
        at: value.unixMillis(Date.now()),
        reason: "test",
        endingDeadlineAt: value.unixMillis(Date.now() + 30_000),
      },
    });
    expect(applied.outcome).toBe("applied");

    const objectKey = `conversations/${conversationId}/recording.ogg`;
    await env.RECORDINGS.put(objectKey, new Uint8Array([1, 2, 3, 4]));
    const egressEnded = await webhookRequest(
      egressEvent("egress_ended", "EV_22222222222P", conversationId, "EGRESS_COMPLETE", [
        { filename: objectKey, size: "4" },
      ]),
    );
    expect(egressEnded.status).toBe(204);

    state = await stub.getState();
    expect(state).toMatchObject({
      tag: ConversationStateTag.Ending,
      data: { artifact: { status: "ready", r2Key: objectKey } },
    });

    const roomFinished = await webhookRequest({
      event: "room_finished",
      id: "EV_22222222222Q",
      createdAt: String(Math.floor(Date.now() / 1000)),
      room: { sid: "RM_test", name: `conversation-${conversationId}` },
    });
    expect(roomFinished.status).toBe(204);
    expect(await stub.getState()).toMatchObject({
      tag: ConversationStateTag.Completed,
      data: {
        transport: { status: "closed" },
        artifact: { status: "ready" },
      },
    });
  });

  it("keeps upload pending when the reported R2 object is not available", async () => {
    const conversationId = await createStartedConversation("livekit-missing-r2-object");
    const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
    await webhookRequest(
      egressEvent("egress_started", "EV_22222222222R", conversationId, "EGRESS_ACTIVE"),
    );
    let state: ConversationState | null = await stub.getState();
    let result = await stub.applyEvent({
      expectedRevision: state!.revision,
      event: {
        type: ConversationEventType.EndRequested,
        eventId: "test:cancel-before-live",
        at: value.unixMillis(Date.now()),
        reason: "test",
        endingDeadlineAt: value.unixMillis(Date.now() + 30_000),
      },
    });
    expect(result.outcome).toBe("applied");

    const objectKey = `conversations/${conversationId}/recording.ogg`;
    const response = await webhookRequest(
      egressEvent("egress_ended", "EV_22222222222S", conversationId, "EGRESS_COMPLETE", [
        { filename: objectKey, size: "10" },
      ]),
    );
    state = await stub.getState();

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(state).toMatchObject({
      tag: ConversationStateTag.Ending,
      data: { artifact: { status: "uploading", expectedR2Key: objectKey } },
    });
  });
});
