/** Creates the OpenAI Realtime model adapter and observes its lifecycle readiness signals. */
import * as openai from "@livekit/agents-plugin-openai";

import type { AgentRuntimeConfig } from "./config.js";

export interface RealtimeLifecycleObserver {
  ready(): void;
  failed(): void;
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
}

export function observeRealtimeReadiness(
  session: RealtimeSessionEventSource,
  observer: RealtimeLifecycleObserver,
): void {
  let settled = false;
  session.on("openai_server_event_received", (event) => {
    if (settled || !isOpenAIRealtimeServerEvent(event) || event.type !== "session.updated") return;
    settled = true;
    observer.ready();
  });
  session.on("error", (event) => {
    if (settled || !isRealtimeModelErrorEvent(event) || event.recoverable !== false) return;
    settled = true;
    observer.failed();
  });
  session.on("session_reconnected", () => {
    if (settled) observer.recovered();
  });
}

class ObservedRealtimeModel extends openai.realtime.RealtimeModel {
  constructor(
    options: { apiKey: string; model: string; voice: string },
    private readonly observer: RealtimeLifecycleObserver,
  ) {
    super(options);
  }

  override session(): openai.realtime.RealtimeSession {
    const session = super.session();
    observeRealtimeReadiness(session, this.observer);
    return session;
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

function isOpenAIRealtimeServerEvent(value: unknown): value is OpenAIRealtimeServerEvent {
  return typeof value === "object" && value !== null && "type" in value;
}

function isRealtimeModelErrorEvent(value: unknown): value is RealtimeModelErrorEvent {
  return typeof value === "object" && value !== null && "recoverable" in value;
}
