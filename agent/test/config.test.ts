/** Verifies agent environment parsing and validation behavior. */
import { describe, expect, it } from "vitest";

import { readAgentRuntimeConfig } from "../src/config.js";

describe("readAgentRuntimeConfig", () => {
  it("uses the approved Realtime defaults", () => {
    const result = readAgentRuntimeConfig({ OPENAI_API_KEY: "test-key" });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toEqual({
      openAIApiKey: "test-key",
      realtimeModel: "gpt-realtime-2.1",
      realtimeVoice: "marin",
      allowSyntheticMetadata: false,
      controlPlaneUrl: null,
      callbackToken: null,
    });
  });

  it("accepts explicit model, voice, and local metadata overrides", () => {
    const result = readAgentRuntimeConfig({
      OPENAI_API_KEY: "test-key",
      OPENAI_REALTIME_MODEL: "gpt-realtime-2.1-mini",
      OPENAI_REALTIME_VOICE: "coral",
      AGENT_ALLOW_SYNTHETIC_METADATA: "true",
      AGENT_CONTROL_PLANE_URL: "https://control.example.test/",
      AGENT_CALLBACK_TOKEN: "callback-secret",
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toEqual({
      openAIApiKey: "test-key",
      realtimeModel: "gpt-realtime-2.1-mini",
      realtimeVoice: "coral",
      allowSyntheticMetadata: true,
      controlPlaneUrl: "https://control.example.test",
      callbackToken: "callback-secret",
    });
  });

  it("rejects missing credentials and invalid flags without echoing values", () => {
    expect(readAgentRuntimeConfig({})).toMatchObject({
      status: "error",
      error: { code: "missing_openai_api_key", message: "OPENAI_API_KEY is required" },
    });
    expect(
      readAgentRuntimeConfig({
        OPENAI_API_KEY: "sensitive-value",
        AGENT_ALLOW_SYNTHETIC_METADATA: "yes",
      }),
    ).toMatchObject({
      status: "error",
      error: {
        code: "invalid_synthetic_metadata_flag",
        message: "AGENT_ALLOW_SYNTHETIC_METADATA must be true or false",
      },
    });
  });
});
