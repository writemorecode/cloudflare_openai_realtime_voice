/** Verifies Realtime model construction and lifecycle-observer behavior. */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createRealtimeModel, observeRealtimeReadiness } from "../src/model.js";

describe("createRealtimeModel", () => {
  it("passes the configured API key, model, and voice to the plugin", () => {
    const model = createRealtimeModel(
      {
        openAIApiKey: "test-key",
        realtimeModel: "gpt-realtime-2.1",
        realtimeVoice: "marin",
        allowSyntheticMetadata: false,
        controlPlaneUrl: null,
        callbackToken: null,
      },
      { ready: vi.fn(), failed: vi.fn(), recovered: vi.fn() },
    ) as unknown as { _options: unknown };

    expect(model._options).toEqual(
      expect.objectContaining({
        apiKey: "test-key",
        model: "gpt-realtime-2.1",
        voice: "marin",
      }),
    );
  });

  it("reports readiness only after OpenAI accepts the session configuration", () => {
    const session = new EventEmitter();
    const observer = { ready: vi.fn(), failed: vi.fn(), recovered: vi.fn() };
    observeRealtimeReadiness(session, observer);

    session.emit("openai_server_event_received", { type: "session.created" });
    expect(observer.ready).not.toHaveBeenCalled();

    session.emit("openai_server_event_received", { type: "session.updated" });
    session.emit("openai_server_event_received", { type: "session.updated" });
    expect(observer.ready).toHaveBeenCalledOnce();
    expect(observer.failed).not.toHaveBeenCalled();
  });

  it("rejects readiness on an unrecoverable provider error", () => {
    const session = new EventEmitter();
    const observer = { ready: vi.fn(), failed: vi.fn(), recovered: vi.fn() };
    observeRealtimeReadiness(session, observer);

    session.emit("error", { recoverable: true });
    session.emit("error", { recoverable: false });

    expect(observer.ready).not.toHaveBeenCalled();
    expect(observer.failed).toHaveBeenCalledOnce();
  });

  it("reports provider recovery only after initial readiness", () => {
    const session = new EventEmitter();
    const observer = { ready: vi.fn(), failed: vi.fn(), recovered: vi.fn() };
    observeRealtimeReadiness(session, observer);

    session.emit("session_reconnected");
    expect(observer.recovered).not.toHaveBeenCalled();

    session.emit("openai_server_event_received", { type: "session.updated" });
    session.emit("session_reconnected");
    expect(observer.recovered).toHaveBeenCalledOnce();
  });
});
