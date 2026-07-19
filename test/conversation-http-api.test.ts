import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StartConversationResponse } from "../src/worker/http/conversation-api";
import { authenticatedHeaders } from "./auth-helpers";

const API_ORIGIN = "https://api.example.test";
const ALLOWED_ORIGIN = "http://localhost:5173";

afterEach(() => vi.restoreAllMocks());

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const requestHeaders = await authenticatedHeaders(init.headers);
  if (!requestHeaders.has("Origin")) requestHeaders.set("Origin", ALLOWED_ORIGIN);
  return exports.default.fetch(
    new Request(`${API_ORIGIN}${path}`, {
      ...init,
      headers: requestHeaders,
    }),
  );
}

async function createConversation(key: string) {
  const response = await api("/v1/conversations", {
    method: "POST",
    headers: { "Idempotency-Key": key },
  });
  return { response, state: await response.json<Record<string, unknown>>() };
}

describe("Worker HTTP boundary", () => {
  it("requires a browser session and enforces the configured CORS origin", async () => {
    const missing = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/conversations`, {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "Idempotency-Key": "authentication-key" },
      }),
    );
    const preflight = await api("/v1/conversations", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const denied = await api("/v1/conversations", {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Idempotency-Key": "origin-denied" },
    });
    const malformed = await api("/v1/conversations", {
      method: "POST",
      headers: { Origin: "not-a-url", "Idempotency-Key": "malformed-origin" },
    });
    const pathBearing = await api("/v1/conversations", {
      method: "POST",
      headers: { Origin: `${ALLOWED_ORIGIN}/unexpected`, "Idempotency-Key": "origin-with-path" },
    });
    expect(missing.status).toBe(401);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(denied.status).toBe(403);
    expect(malformed.status).toBe(403);
    expect(pathBearing.status).toBe(403);
  });

  it("creates conversations deterministically and idempotently", async () => {
    const first = await createConversation("create-idempotently");
    const second = await createConversation("create-idempotently");
    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(200);
    expect(second.state.conversationId).toBe(first.state.conversationId);
    expect(first.state).toMatchObject({
      state: "created",
      revision: 0,
      transport: { status: "idle" },
      artifact: { status: "pending" },
    });
  });

  it("accepts an empty request stream but rejects a non-empty request body", async () => {
    const empty = await api("/v1/conversations", {
      method: "POST",
      headers: { "Idempotency-Key": "empty-request-stream" },
      body: new Uint8Array(0),
    });
    const nonEmpty = await api("/v1/conversations", {
      method: "POST",
      headers: { "Idempotency-Key": "non-empty-request-stream" },
      body: "{}",
    });

    expect(empty.status).toBe(201);
    expect(nonEmpty.status).toBe(400);
    expect(await nonEmpty.json()).toMatchObject({ code: "unexpected_request_body" });
  });

  it("makes start provider-neutral, asynchronous, and idempotent", async () => {
    const externalFetch = vi.spyOn(globalThis, "fetch");
    const created = await createConversation("provider-neutral-start");
    const id = String(created.state.conversationId);
    const first = await api(`/v1/conversations/${id}/start`, { method: "POST" });
    const body = await first.json<StartConversationResponse>();
    const second = await api(`/v1/conversations/${id}/start`, { method: "POST" });
    const repeated = await second.json<StartConversationResponse>();
    const read = await api(`/v1/conversations/${id}/state`);
    const persisted = await read.json<Record<string, unknown>>();

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(body).toMatchObject({
      conversationId: id,
      state: "starting",
      revision: 1,
      transport: { status: "connecting", epoch: 1 },
      artifact: { status: "pending" },
    });
    expect(repeated).toEqual(body);
    expect(persisted).toEqual(body);
    expect(externalFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(
      /meeting|participant|token|recordingId|objectKey|etag/i,
    );

    const stub = env.CONVERSATION_SESSIONS.getByName(id);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
      body.activeDeadlineAt,
    );
  });

  it("converges concurrent start requests on one revision", async () => {
    const created = await createConversation("concurrent-start");
    const path = `/v1/conversations/${String(created.state.conversationId)}/start`;
    const responses = await Promise.all([
      api(path, { method: "POST" }),
      api(path, { method: "POST" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    const bodies = await Promise.all(
      responses.map((response) => response.json<StartConversationResponse>()),
    );
    expect(bodies[0]?.revision).toBe(1);
    expect(bodies[1]).toEqual(bodies[0]);
  });
});
