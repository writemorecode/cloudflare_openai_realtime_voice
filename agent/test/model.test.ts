/** Verifies Realtime model construction and lifecycle-observer behavior. */
import { EventEmitter } from "node:events";

import { APIConnectionError, llm } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";

import {
  createRealtimeModel,
  observeRealtimeReadiness,
  realtimeCompatibleChatContext,
} from "../src/model.js";

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
      { ready: vi.fn(), failed: vi.fn(), interrupted: vi.fn(), recovered: vi.fn() },
    );

    expect(Reflect.get(model, "_options")).toEqual(
      expect.objectContaining({
        apiKey: "test-key",
        model: "gpt-realtime-2.1",
        voice: "marin",
      }),
    );
  });

  it("reports readiness only after OpenAI accepts the session configuration", () => {
    const session = new EventEmitter();
    const observer = {
      ready: vi.fn(),
      failed: vi.fn(),
      interrupted: vi.fn(),
      recovered: vi.fn(),
    };
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
    const observer = {
      ready: vi.fn(),
      failed: vi.fn(),
      interrupted: vi.fn(),
      recovered: vi.fn(),
    };
    observeRealtimeReadiness(session, observer);

    session.emit("error", { recoverable: true, error: new Error("request rejected") });
    session.emit("error", { recoverable: false, error: new Error("provider failed") });

    expect(observer.ready).not.toHaveBeenCalled();
    expect(observer.failed).toHaveBeenCalledOnce();
  });

  it("reports connection interruption and recovery only after initial readiness", () => {
    const session = new EventEmitter();
    const observer = {
      ready: vi.fn(),
      failed: vi.fn(),
      interrupted: vi.fn(),
      recovered: vi.fn(),
    };
    observeRealtimeReadiness(session, observer);

    session.emit("error", {
      recoverable: true,
      error: new APIConnectionError({ message: "connection lost" }),
    });
    session.emit("session_reconnected");
    expect(observer.interrupted).not.toHaveBeenCalled();
    expect(observer.recovered).not.toHaveBeenCalled();

    session.emit("openai_server_event_received", { type: "session.updated" });
    session.emit("error", { recoverable: true, error: new Error("request rejected") });
    expect(observer.interrupted).not.toHaveBeenCalled();

    session.emit("error", {
      recoverable: true,
      error: new APIConnectionError({ message: "connection lost" }),
    });
    session.emit("session_reconnected");
    expect(observer.interrupted).toHaveBeenCalledOnce();
    expect(observer.recovered).toHaveBeenCalledOnce();
  });

  it("removes AgentTask configuration records before OpenAI context synchronization", () => {
    const context = llm.ChatContext.empty();
    context.addMessage({ role: "user", content: "Student answer" });
    context.insert(new llm.AgentConfigUpdate({ toolsAdded: ["complete_question"] }));

    const compatible = realtimeCompatibleChatContext(context);

    expect(compatible.items.map((item) => item.type)).toEqual(["message"]);
    expect(context.items.map((item) => item.type)).toEqual(["message", "agent_config_update"]);
  });
});
