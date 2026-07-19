import { describe, expect, it } from "vitest";

import { readAgentRuntimeConfig } from "../src/config.js";

describe("readAgentRuntimeConfig", () => {
  it("uses the approved Realtime defaults", () => {
    expect(readAgentRuntimeConfig({ OPENAI_API_KEY: "test-key" })).toEqual({
      openAIApiKey: "test-key",
      realtimeModel: "gpt-realtime-2.1",
      realtimeVoice: "marin",
      allowSyntheticMetadata: false,
      controlPlaneUrl: null,
      callbackToken: null,
    });
  });

  it("accepts explicit model, voice, and local metadata overrides", () => {
    expect(
      readAgentRuntimeConfig({
        OPENAI_API_KEY: "test-key",
        OPENAI_REALTIME_MODEL: "gpt-realtime-2.1-mini",
        OPENAI_REALTIME_VOICE: "coral",
        AGENT_ALLOW_SYNTHETIC_METADATA: "true",
        AGENT_CONTROL_PLANE_URL: "https://control.example.test/",
        AGENT_CALLBACK_TOKEN: "callback-secret",
      }),
    ).toEqual({
      openAIApiKey: "test-key",
      realtimeModel: "gpt-realtime-2.1-mini",
      realtimeVoice: "coral",
      allowSyntheticMetadata: true,
      controlPlaneUrl: "https://control.example.test",
      callbackToken: "callback-secret",
    });
  });

  it("rejects missing credentials and invalid flags without echoing values", () => {
    expect(() => readAgentRuntimeConfig({})).toThrow("OPENAI_API_KEY is required");
    expect(() =>
      readAgentRuntimeConfig({
        OPENAI_API_KEY: "sensitive-value",
        AGENT_ALLOW_SYNTHETIC_METADATA: "yes",
      }),
    ).toThrow("AGENT_ALLOW_SYNTHETIC_METADATA must be true or false");
  });
});
