/** Verifies lifecycle-report delivery, retry, and failure handling. */
import { describe, expect, it, vi } from "vitest";

import { HttpAgentLifecycleReporter, createLifecycleReporter } from "../src/reporter.js";

const event = {
  eventId: "agent:e570d451-98dc-4ba8-867b-735c652114b7:1:realtime-ready",
  conversationId: "e570d451-98dc-4ba8-867b-735c652114b7",
  roomName: "conversation-e570d451-98dc-4ba8-867b-735c652114b7",
  transportEpoch: 1,
  occurredAt: "2026-07-15T10:00:00.000Z",
};

describe("HttpAgentLifecycleReporter", () => {
  it("delivers versioned authenticated lifecycle events", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 204 }),
    );
    const reporter = new HttpAgentLifecycleReporter(
      "https://control.example.test/v1/integrations/livekit/agent-events",
      "callback-secret",
      fetchMock,
    );

    await reporter.realtimeReady(event);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://control.example.test/v1/integrations/livekit/agent-events",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer callback-secret",
          "Content-Type": "application/json",
        },
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      version: 1,
      type: "realtime_ready",
      ...event,
    });
  });

  it("requires callback configuration and sanitizes response failures", async () => {
    expect(createLifecycleReporter({ controlPlaneUrl: null, callbackToken: null })).toMatchObject({
      status: "error",
      error: {
        code: "reporter_not_configured",
        message: "Agent control-plane reporting is not configured",
      },
    });
    const reporter = new HttpAgentLifecycleReporter(
      "https://control.example.test/v1/integrations/livekit/agent-events",
      "sensitive-token",
      async () => new Response("provider details", { status: 503 }),
      { retryBaseDelayMs: 0 },
    );
    await expect(reporter.realtimeReady(event)).rejects.toThrow(
      "agent.lifecycle_report_failed:503",
    );
  });

  it("retries transient responses with the same idempotent payload", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleep = vi.fn(async () => undefined);
    const reporter = new HttpAgentLifecycleReporter(
      "https://control.example.test/v1/integrations/livekit/agent-events",
      "callback-secret",
      fetchMock,
      { sleep },
    );

    await reporter.realtimeReady(event);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
    const bodies = fetchMock.mock.calls.map((call) => call[1]?.body);
    expect(new Set(bodies).size).toBe(1);
  });

  it("does not retry permanent client errors", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 409 }),
    );
    const reporter = new HttpAgentLifecycleReporter(
      "https://control.example.test/v1/integrations/livekit/agent-events",
      "callback-secret",
      fetchMock,
    );

    await expect(reporter.realtimeReady(event)).rejects.toThrow(
      "agent.lifecycle_report_failed:409",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts stalled attempts and reports a sanitized timeout", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("secret network detail")));
        }),
    );
    const reporter = new HttpAgentLifecycleReporter(
      "https://control.example.test/v1/integrations/livekit/agent-events",
      "callback-secret",
      fetchMock,
      { maxAttempts: 1, requestTimeoutMs: 1 },
    );

    await expect(reporter.realtimeReady(event)).rejects.toThrow(
      "agent.lifecycle_report_failed:timeout",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
