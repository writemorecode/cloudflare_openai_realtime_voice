import { AccessToken, TrackSource, TokenVerifier } from "livekit-server-sdk";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import {
  createLiveKitAccess,
  stopLiveKitAccess,
  type LiveKitAccessServices,
  type LiveKitShutdownServices,
} from "../src/worker/integrations/livekit/access";
import { cloudflareConversationSessions } from "../src/worker/adapters/cloudflare";
import type {
  LiveKitAccessDependencies,
  LiveKitDispatchResource,
  LiveKitEgressResource,
  LiveKitShutdownDependencies,
} from "../src/worker/ports/foundation";
import {
  ConversationEventType,
  ConversationStateTag,
  value,
  type ConversationState,
} from "../src/domain/conversation-state-machine";
import type { ApplyEventResult } from "../src/durable-object/conversation-session";
import { aggregateValue } from "./aggregate-store-test-utils";
import { authenticatedHeaders } from "./auth-helpers";

const API_ORIGIN = "https://api.example.test";
const BROWSER_ORIGIN = "http://localhost:5173";
const LIVEKIT_API_KEY = "test-livekit-api-key";
const LIVEKIT_API_SECRET = "test-livekit-api-secret-with-sufficient-entropy";
const FIXED_NOW = 1_700_000_000_000;
const FIXED_LEASE_ID = "11111111-1111-4111-8111-111111111111";

function accessDependencies(liveKit: LiveKitAccessServices): LiveKitAccessDependencies {
  return {
    clock: { now: vi.fn(() => FIXED_NOW) },
    ids: { randomUuid: vi.fn(() => FIXED_LEASE_ID) },
    conversations: cloudflareConversationSessions(env),
    liveKit,
  };
}

function shutdownDependencies(liveKit: LiveKitShutdownServices): LiveKitShutdownDependencies {
  return {
    clock: { now: vi.fn(() => FIXED_NOW) },
    ids: { randomUuid: vi.fn(() => FIXED_LEASE_ID) },
    conversations: cloudflareConversationSessions(env),
    liveKit,
  };
}

async function createStartedConversation(key: string): Promise<string> {
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

function fakeServices(
  options: {
    readonly onDispatchCreated?: (roomName: string) => Promise<void>;
  } = {},
): LiveKitAccessServices & {
  readonly createRoom: ReturnType<typeof vi.fn>;
  readonly createDispatch: ReturnType<typeof vi.fn>;
  readonly startEgress: ReturnType<typeof vi.fn>;
} {
  let roomExists = false;
  const dispatches: LiveKitDispatchResource[] = [];
  const egresses: LiveKitEgressResource[] = [];
  return {
    roomExists: vi.fn(async () => roomExists),
    createRoom: vi.fn(async () => {
      roomExists = true;
    }),
    listDispatches: vi.fn(async () => dispatches),
    createDispatch: vi.fn(async (roomName: string, metadata: string) => {
      const dispatch = {
        id: "AD_test",
        agentName: "oral-exam-agent",
        metadata,
      };
      dispatches.push(dispatch);
      await options.onDispatchCreated?.(roomName);
      return dispatch;
    }),
    listActiveEgress: vi.fn(async () => egresses),
    startEgress: vi.fn(async () => {
      const egress = { egressId: "EG_test", active: true };
      egresses.push(egress);
      return egress;
    }),
    mintParticipantToken: vi.fn(async (roomName: string, identity: string) => {
      const token = new AccessToken(
        "test-livekit-api-key",
        "test-livekit-api-secret-with-sufficient-entropy",
        { identity, ttl: 600 },
      );
      token.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE],
        canPublishData: false,
        canSubscribe: true,
      });
      return token.toJwt();
    }),
  };
}

async function postAgentReady(conversationId: string): Promise<Response> {
  return exports.default.fetch(
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
        roomName: `conversation-${conversationId}`,
        transportEpoch: 1,
        occurredAt: new Date().toISOString(),
      }),
    }),
  );
}

async function webhookRequest(payload: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(payload);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
  );
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  token.sha256 = btoa(String.fromCharCode(...digest));
  return exports.default.fetch(
    new Request(`${API_ORIGIN}/v1/integrations/livekit/webhook`, {
      method: "POST",
      headers: {
        Authorization: await token.toJwt(),
        "Content-Type": "application/webhook+json",
      },
      body,
    }),
  );
}

function fakeShutdownServices(): LiveKitShutdownServices & {
  readonly stopEgress: ReturnType<typeof vi.fn>;
  readonly deleteDispatch: ReturnType<typeof vi.fn>;
  readonly deleteRoom: ReturnType<typeof vi.fn>;
} {
  let egressExists = true;
  let dispatchExists = true;
  let roomExists = true;
  return {
    getEgress: vi.fn(async () =>
      egressExists ? { egressId: "EG_test", active: true } : undefined,
    ),
    stopEgress: vi.fn(async () => {
      egressExists = false;
    }),
    getDispatch: vi.fn(async () =>
      dispatchExists
        ? {
            id: "AD_test",
            agentName: "oral-exam-agent",
            metadata: "",
          }
        : undefined,
    ),
    deleteDispatch: vi.fn(async () => {
      dispatchExists = false;
    }),
    roomExists: vi.fn(async () => roomExists),
    deleteRoom: vi.fn(async () => {
      roomExists = false;
    }),
  };
}

describe("LiveKit access", () => {
  it("creates one room, explicit dispatch, and audio recording across retries", async () => {
    const conversationId = await createStartedConversation("livekit-access-idempotent");
    const services = fakeServices();
    const dependencies = accessDependencies(services);

    const first = await createLiveKitAccess(env, conversationId, dependencies);
    const repeated = await createLiveKitAccess(env, conversationId, dependencies);

    expect(first).toMatchObject({ ok: true });
    expect(repeated).toMatchObject({ ok: true });
    if (!first.ok || !repeated.ok) return;
    expect(first.value.roomName).toBe(`conversation-${conversationId}`);
    expect(first.value.serverUrl).toBe("wss://test.livekit.cloud");
    expect(repeated.value.roomName).toBe(first.value.roomName);
    expect(services.createRoom).toHaveBeenCalledTimes(1);
    expect(services.createDispatch).toHaveBeenCalledTimes(1);
    expect(services.startEgress).toHaveBeenCalledTimes(1);
    expect(dependencies.clock.now).toHaveBeenCalled();
    expect(dependencies.ids.randomUuid).toHaveBeenCalledTimes(2);

    const grants = await new TokenVerifier(
      "test-livekit-api-key",
      "test-livekit-api-secret-with-sufficient-entropy",
    ).verify(first.value.participantToken);
    expect(grants.sub).toBe(`browser-${conversationId}`);
    expect(grants.video).toMatchObject({
      roomJoin: true,
      room: first.value.roomName,
      canPublish: true,
      canPublishSources: ["microphone"],
      canPublishData: false,
      canSubscribe: true,
    });
  });

  it("latches agent readiness during provisioning and reaches live after browser joins", async () => {
    const conversationId = await createStartedConversation("livekit-access-readiness-race");
    const roomName = `conversation-${conversationId}`;
    const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
    const services = fakeServices({
      onDispatchCreated: async () => {
        expect((await postAgentReady(conversationId)).status).toBe(204);
        expect((await postAgentReady(conversationId)).status).toBe(204);
        expect(
          (
            await webhookRequest({
              event: "participant_joined",
              id: "EV_33333333333A",
              createdAt: String(Math.floor(Date.now() / 1000)),
              room: { name: roomName },
              participant: { identity: "agent-runtime-identity", kind: "AGENT" },
            })
          ).status,
        ).toBe(204);
        expect(
          (
            await webhookRequest({
              event: "track_published",
              id: "EV_33333333333B",
              createdAt: String(Math.floor(Date.now() / 1000)),
              room: { name: roomName },
              participant: { identity: "agent-runtime-identity" },
              track: { sid: "TR_agent", type: "AUDIO", source: "MICROPHONE" },
            })
          ).status,
        ).toBe(204);
        await expect(
          stub.recordLiveKitMediaObservation({
            eventId: "test:wrong-room-during-provisioning",
            kind: "agent_audio_published",
            participantIdentity: "agent-runtime-identity",
            roomName: "conversation-e570d451-98dc-4ba8-867b-735c652114b7",
            transportEpoch: 1,
          }),
        ).resolves.toEqual({ outcome: "rejected", reason: "room_mismatch" });
        await expect(
          stub.recordLiveKitMediaObservation({
            eventId: "test:wrong-epoch-during-provisioning",
            kind: "agent_audio_published",
            participantIdentity: "agent-runtime-identity",
            roomName,
            transportEpoch: 2,
          }),
        ).resolves.toEqual({ outcome: "rejected", reason: "epoch_mismatch" });
      },
    });

    const access = await createLiveKitAccess(env, conversationId, accessDependencies(services));
    expect(access.ok).toBe(true);
    expect(await stub.getLiveKitTransportEvidence()).toMatchObject({
      transportEpoch: 1,
      agentParticipantActive: true,
      agentParticipantIdentity: "agent-runtime-identity",
      agentAudioPublished: true,
      realtimeReady: true,
    });

    expect(
      (
        await webhookRequest({
          event: "egress_started",
          id: "EV_33333333333C",
          createdAt: String(Math.floor(Date.now() / 1000)),
          egressInfo: {
            egressId: "EG_test",
            roomName,
            status: "EGRESS_ACTIVE",
            fileResults: [],
          },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await webhookRequest({
          event: "participant_joined",
          id: "EV_33333333333D",
          createdAt: String(Math.floor(Date.now() / 1000)),
          room: { name: roomName },
          participant: { identity: `browser-${conversationId}`, kind: "STANDARD" },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await webhookRequest({
          event: "track_published",
          id: "EV_33333333333E",
          createdAt: String(Math.floor(Date.now() / 1000)),
          room: { name: roomName },
          participant: { identity: `browser-${conversationId}` },
          track: { sid: "TR_browser", type: "AUDIO", source: "MICROPHONE" },
        })
      ).status,
    ).toBe(204);

    const live = aggregateValue<ConversationState | null>(await stub.getState());
    expect(live).toMatchObject({
      tag: ConversationStateTag.Live,
      data: {
        transport: { status: "connected", epoch: 1 },
        artifact: { status: "recording" },
      },
    });
    expect(live).not.toBeNull();
    const ending = aggregateValue<ApplyEventResult>(
      await stub.applyEvent({
        expectedRevision: live!.revision,
        event: {
          type: ConversationEventType.EndRequested,
          eventId: "test:end-live-after-provisioning-race",
          at: value.unixMillis(Date.now()),
          reason: "user_requested",
          endingDeadlineAt: value.unixMillis(Date.now() + 30_000),
        },
      }),
    );
    expect(ending).toMatchObject({
      outcome: "applied",
      state: { tag: ConversationStateTag.Ending, data: { target: { kind: "complete" } } },
    });
  });

  it("rejects access before the provider-neutral start command", async () => {
    const created = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/conversations`, {
        method: "POST",
        headers: await authenticatedHeaders({
          Origin: BROWSER_ORIGIN,
          "Idempotency-Key": "livekit-access-before-start",
        }),
      }),
    );
    const body = await created.json<{ conversationId: string }>();

    await expect(
      createLiveKitAccess(env, body.conversationId, accessDependencies(fakeServices())),
    ).resolves.toMatchObject({
      ok: false,
      error: { status: 409, code: "conversation_not_starting" },
    });
  });

  it("stops recording, dispatch, and room exactly once after shutdown begins", async () => {
    const conversationId = await createStartedConversation("livekit-access-shutdown");
    await createLiveKitAccess(env, conversationId, accessDependencies(fakeServices()));
    const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
    const state = aggregateValue<ConversationState | null>(await stub.getState());
    expect(state).not.toBeNull();
    const ending = aggregateValue<ApplyEventResult>(
      await stub.applyEvent({
        expectedRevision: state!.revision,
        event: {
          type: ConversationEventType.EndRequested,
          eventId: "test:livekit-shutdown-requested",
          at: value.unixMillis(Date.now()),
          reason: "test",
          endingDeadlineAt: value.unixMillis(Date.now() + 30_000),
        },
      }),
    );
    expect(ending.outcome).toBe("applied");

    const services = fakeShutdownServices();
    const dependencies = shutdownDependencies(services);
    expect(await stopLiveKitAccess(env, conversationId, dependencies)).toEqual({
      ok: true,
      value: "stopped",
    });
    expect(await stopLiveKitAccess(env, conversationId, dependencies)).toEqual({
      ok: true,
      value: "already_stopped",
    });
    expect(services.stopEgress).toHaveBeenCalledTimes(1);
    expect(services.deleteDispatch).toHaveBeenCalledTimes(1);
    expect(services.deleteRoom).toHaveBeenCalledTimes(1);
  });

  it("rejects provider teardown while the conversation is active", async () => {
    const conversationId = await createStartedConversation("livekit-access-active-shutdown");
    await createLiveKitAccess(env, conversationId, accessDependencies(fakeServices()));

    await expect(
      stopLiveKitAccess(env, conversationId, shutdownDependencies(fakeShutdownServices())),
    ).resolves.toMatchObject({
      ok: false,
      error: { status: 409, code: "conversation_not_ending" },
    });
  });
});
