/** Creates the OpenAI Realtime model adapter and observes its lifecycle readiness signals. */
import * as openai from "@livekit/agents-plugin-openai";
import { APIConnectionError, llm } from "@livekit/agents";

import type { AgentRuntimeConfig } from "./config.js";

export interface RealtimeLifecycleObserver {
  ready(): void;
  failed(): void;
  interrupted(): void;
  recovered(): void;
}

interface RealtimeSessionEventSource {
  on(event: "error", listener: (event: unknown) => void): unknown;
  on(event: "openai_server_event_received", listener: (event: unknown) => void): unknown;
  on(event: "session_reconnected", listener: () => void): unknown;
}

interface OpenAIRealtimeServerEvent {
  readonly type?: unknown;
}

interface RealtimeModelErrorEvent {
  readonly recoverable?: unknown;
  readonly error?: unknown;
}

export function observeRealtimeReadiness(
  session: RealtimeSessionEventSource,
  observer: RealtimeLifecycleObserver,
): void {
  let initialSettled = false;
  let ready = false;
  session.on("openai_server_event_received", (event) => {
    if (initialSettled || !isOpenAIRealtimeServerEvent(event) || event.type !== "session.updated") {
      return;
    }
    initialSettled = true;
    ready = true;
    observer.ready();
  });
  session.on("error", (event) => {
    if (!isRealtimeModelErrorEvent(event)) return;
    if (ready && event.recoverable === true && event.error instanceof APIConnectionError) {
      observer.interrupted();
      return;
    }
    if (initialSettled || event.recoverable !== false) return;
    initialSettled = true;
    observer.failed();
  });
  session.on("session_reconnected", () => {
    if (ready) observer.recovered();
  });
}

class ObservedRealtimeSession extends openai.realtime.RealtimeSession {
  constructor(model: openai.realtime.RealtimeModel, observer: RealtimeLifecycleObserver) {
    super(model);
    observeRealtimeReadiness(this, observer);
  }

  override updateChatCtx(chatCtx: llm.ChatContext): Promise<void> {
    return super.updateChatCtx(realtimeCompatibleChatContext(chatCtx));
  }
}

class ObservedRealtimeModel extends openai.realtime.RealtimeModel {
  constructor(
    options: { apiKey: string; model: string; voice: string },
    private readonly observer: RealtimeLifecycleObserver,
  ) {
    super(options);
  }

  override session(): openai.realtime.RealtimeSession {
    return new ObservedRealtimeSession(this, this.observer);
  }
}

export function createRealtimeModel(
  config: AgentRuntimeConfig,
  observer: RealtimeLifecycleObserver,
): openai.realtime.RealtimeModel {
  return new ObservedRealtimeModel(
    {
      apiKey: config.openAIApiKey,
      model: config.realtimeModel,
      voice: config.realtimeVoice,
    },
    observer,
  );
}

export function realtimeCompatibleChatContext(chatCtx: llm.ChatContext): llm.ChatContext {
  return chatCtx.copy({ excludeConfigUpdate: true });
}

function isOpenAIRealtimeServerEvent(value: unknown): value is OpenAIRealtimeServerEvent {
  return typeof value === "object" && value !== null && "type" in value;
}

function isRealtimeModelErrorEvent(value: unknown): value is RealtimeModelErrorEvent {
  return typeof value === "object" && value !== null && "recoverable" in value;
}
