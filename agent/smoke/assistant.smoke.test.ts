import { initializeLogger, voice } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { describe, expect, it } from "vitest";

import { createAssistant } from "../src/assistant.js";
import { readAgentRuntimeConfig } from "../src/config.js";

initializeLogger({ pretty: false, level: "warn" });

describe("voice assistant smoke test", () => {
  it("responds to a greeting with an assistant message", async () => {
    const config = readAgentRuntimeConfig(process.env);
    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        apiKey: config.openAIApiKey,
        model: config.realtimeModel,
        voice: config.realtimeVoice,
        modalities: ["text"],
      }),
    });

    await session.start({ agent: createAssistant() });
    const result = await session.run({ userInput: "Hello", inputModality: "text" }).wait();
    const assistantMessage = result.expect.at(-1).isMessage({ role: "assistant" }).event();

    expect(assistantMessage.item.content.length).toBeGreaterThan(0);
  });
});
