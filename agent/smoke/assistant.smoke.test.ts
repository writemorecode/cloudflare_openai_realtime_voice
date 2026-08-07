/** Runs an opt-in end-to-end smoke check against the configured LiveKit and Realtime services. */
import { initializeLogger, voice } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { Result } from "better-result";
import { describe, expect, it } from "vitest";

import { createAssistant } from "../src/assistant.js";
import { readAgentRuntimeConfig } from "../src/config.js";

initializeLogger({ pretty: false, level: "warn" });

describe("voice assistant smoke test", () => {
  it("responds to a greeting with an assistant message", async () => {
    const config = readAgentRuntimeConfig(process.env);
    expect(config.isOk()).toBe(true);
    if (!Result.isOk(config)) return;
    const configValue = config.value;
    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        apiKey: configValue.openAIApiKey,
        model: configValue.realtimeModel,
        voice: configValue.realtimeVoice,
        modalities: ["text"],
      }),
    });

    await session.start({ agent: createAssistant() });
    const result = await session.run({ userInput: "Hello", inputModality: "text" }).wait();
    const assistantMessage = result.expect.at(-1).isMessage({ role: "assistant" }).event();

    expect(assistantMessage.item.content.length).toBeGreaterThan(0);
  });
});
