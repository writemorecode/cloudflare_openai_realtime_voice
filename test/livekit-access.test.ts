import { AgentDispatch, EgressInfo, EgressStatus, TokenVerifier } from "livekit-server-sdk";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import {
  createLiveKitAccess,
  stopLiveKitAccess,
  type LiveKitAccessServices,
  type LiveKitShutdownServices,
} from "../src/worker/integrations/livekit/access";
import { ConversationEventType, value } from "../src/domain/conversation-state-machine";
import { authenticatedHeaders } from "./auth-helpers";

const API_ORIGIN = "https://api.example.test";
const BROWSER_ORIGIN = "http://localhost:5173";

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

function fakeServices(): LiveKitAccessServices & {
  readonly createRoom: ReturnType<typeof vi.fn>;
  readonly createDispatch: ReturnType<typeof vi.fn>;
  readonly startEgress: ReturnType<typeof vi.fn>;
} {
  let roomExists = false;
  const dispatches: AgentDispatch[] = [];
  const egresses: EgressInfo[] = [];
  return {
    roomExists: vi.fn(async () => roomExists),
    createRoom: vi.fn(async () => {
      roomExists = true;
    }),
    listDispatches: vi.fn(async () => dispatches),
    createDispatch: vi.fn(async (roomName: string, metadata: string) => {
      const dispatch = new AgentDispatch({
        id: "AD_test",
        agentName: "oral-exam-agent",
        room: roomName,
        metadata,
      });
      dispatches.push(dispatch);
      return dispatch;
    }),
    listActiveEgress: vi.fn(async () => egresses),
    startEgress: vi.fn(async (roomName: string) => {
      const egress = new EgressInfo({ egressId: "EG_test", roomName });
      egresses.push(egress);
      return egress;
    }),
    mintParticipantToken: vi.fn(async (roomName: string, identity: string) => {
      const { AccessToken, TrackSource } = await import("livekit-server-sdk");
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

function fakeShutdownServices(
  roomName: string,
  options: { readonly failFirstRoomDelete?: boolean } = {},
): LiveKitShutdownServices & {
  readonly stopEgress: ReturnType<typeof vi.fn>;
  readonly deleteDispatch: ReturnType<typeof vi.fn>;
  readonly deleteRoom: ReturnType<typeof vi.fn>;
} {
  let egressExists = true;
  let dispatchExists = true;
  let roomExists = true;
  let roomDeleteAttempts = 0;
  return {
    getEgress: vi.fn(async () =>
      egressExists
        ? new EgressInfo({
            egressId: "EG_test",
            roomName,
            status: EgressStatus.EGRESS_ACTIVE,
          })
        : undefined,
    ),
    stopEgress: vi.fn(async () => {
      egressExists = false;
    }),
    getDispatch: vi.fn(async () =>
      dispatchExists
        ? new AgentDispatch({
            id: "AD_test",
            agentName: "oral-exam-agent",
            room: roomName,
          })
        : undefined,
    ),
    deleteDispatch: vi.fn(async () => {
      dispatchExists = false;
    }),
    roomExists: vi.fn(async () => roomExists),
    deleteRoom: vi.fn(async () => {
      roomDeleteAttempts += 1;
      if (options.failFirstRoomDelete === true && roomDeleteAttempts === 1) {
        throw new Error("transient provider failure");
      }
      roomExists = false;
    }),
  };
}

describe("LiveKit access", () => {
  it("creates one room, explicit dispatch, and audio recording across retries", async () => {
    const conversationId = await createStartedConversation("livekit-access-idempotent");
    const services = fakeServices();

    const first = await createLiveKitAccess(env, conversationId, services);
    const repeated = await createLiveKitAccess(env, conversationId, services);

    expect(first).toMatchObject({ ok: true });
    expect(repeated).toMatchObject({ ok: true });
    if (!first.ok || !repeated.ok) return;
    expect(first.value.roomName).toBe(`conversation-${conversationId}`);
    expect(first.value.serverUrl).toBe("wss://test.livekit.cloud");
    expect(repeated.value.roomName).toBe(first.value.roomName);
    expect(services.createRoom).toHaveBeenCalledTimes(1);
    expect(services.createDispatch).toHaveBeenCalledTimes(1);
    expect(services.startEgress).toHaveBeenCalledTimes(1);

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
      createLiveKitAccess(env, body.conversationId, fakeServices()),
    ).resolves.toMatchObject({
      ok: false,
      error: { status: 409, code: "conversation_not_starting" },
    });
  });

  it("stops recording, dispatch, and room exactly once after shutdown begins", async () => {
    const conversationId = await createStartedConversation("livekit-access-shutdown");
    await createLiveKitAccess(env, conversationId, fakeServices());
    const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
    const state = await stub.getState();
    expect(state).not.toBeNull();
    const ending = await stub.applyEvent({
      expectedRevision: state!.revision,
      event: {
        type: ConversationEventType.EndRequested,
        eventId: "test:livekit-shutdown-requested",
        at: value.unixMillis(Date.now()),
        reason: "test",
        endingDeadlineAt: value.unixMillis(Date.now() + 30_000),
      },
    });
    expect(ending.outcome).toBe("applied");

    const services = fakeShutdownServices(`conversation-${conversationId}`);
    expect(await stopLiveKitAccess(env, conversationId, services)).toEqual({
      ok: true,
      value: "stopped",
    });
    expect(await stopLiveKitAccess(env, conversationId, services)).toEqual({
      ok: true,
      value: "already_stopped",
    });
    expect(services.stopEgress).toHaveBeenCalledTimes(1);
    expect(services.deleteDispatch).toHaveBeenCalledTimes(1);
    expect(services.deleteRoom).toHaveBeenCalledTimes(1);
  });

  it("rejects provider teardown while the conversation is active", async () => {
    const conversationId = await createStartedConversation("livekit-access-active-shutdown");
    await createLiveKitAccess(env, conversationId, fakeServices());

    await expect(
      stopLiveKitAccess(
        env,
        conversationId,
        fakeShutdownServices(`conversation-${conversationId}`),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { status: 409, code: "conversation_not_ending" },
    });
  });

  it("converges after a partial provider teardown failure", async () => {
    const conversationId = await createStartedConversation("livekit-access-partial-shutdown");
    await createLiveKitAccess(env, conversationId, fakeServices());
    const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
    const state = await stub.getState();
    expect(state).not.toBeNull();
    await stub.applyEvent({
      expectedRevision: state!.revision,
      event: {
        type: ConversationEventType.EndRequested,
        eventId: "test:livekit-partial-shutdown-requested",
        at: value.unixMillis(Date.now()),
        reason: "test",
        endingDeadlineAt: value.unixMillis(Date.now() + 30_000),
      },
    });

    const services = fakeShutdownServices(`conversation-${conversationId}`, {
      failFirstRoomDelete: true,
    });
    await expect(stopLiveKitAccess(env, conversationId, services)).resolves.toMatchObject({
      ok: false,
      error: { status: 502, code: "livekit_shutdown_failed" },
    });
    expect(await stopLiveKitAccess(env, conversationId, services)).toEqual({
      ok: true,
      value: "stopped",
    });
    expect(services.stopEgress).toHaveBeenCalledTimes(1);
    expect(services.deleteDispatch).toHaveBeenCalledTimes(1);
    expect(services.deleteRoom).toHaveBeenCalledTimes(2);
  });
});
