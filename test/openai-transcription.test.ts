import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isSupportedTranscriptionFileSize,
  MAXIMUM_TRANSCRIPTION_FILE_BYTES,
  requestOpenAiTranscription,
} from "../src/worker/transcription/openai-transcription";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI transcription request", () => {
  it("accepts only valid files within the provider's 25 MB limit", () => {
    expect(isSupportedTranscriptionFileSize(0)).toBe(true);
    expect(isSupportedTranscriptionFileSize(MAXIMUM_TRANSCRIPTION_FILE_BYTES)).toBe(true);
    expect(isSupportedTranscriptionFileSize(MAXIMUM_TRANSCRIPTION_FILE_BYTES + 1)).toBe(false);
    expect(isSupportedTranscriptionFileSize(-1)).toBe(false);
    expect(isSupportedTranscriptionFileSize(Number.NaN)).toBe(false);
  });

  it("uploads recording bytes through the authenticated Gateway using BYOK", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ task: "transcribe", duration: 0, text: "", segments: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestOpenAiTranscription(
      { accountId: "account", gatewayId: "gateway", gatewayToken: "gateway-token" },
      "conversations/id/recording.webm",
      {
        httpMetadata: { contentType: "audio/webm" },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      },
    );
    expect(result.isOk()).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account/gateway/openai/audio/transcriptions",
    );
    expect(init.headers).toEqual({
      "cf-aig-authorization": "Bearer gateway-token",
      "cf-aig-collect-log": "true",
      "cf-aig-skip-cache": "true",
    });
    const body = init.body as FormData;
    expect(body.get("model")).toBe("gpt-4o-transcribe-diarize");
    expect(body.get("response_format")).toBe("diarized_json");
    expect(body.get("chunking_strategy")).toBe("auto");
    const file = body.get("file") as File;
    expect(file.name).toBe("recording.webm");
    expect(file.type).toBe("audio/webm");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("rejects unsuccessful provider responses without retaining their body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("sensitive provider response", { status: 401 })),
    );

    expect(
      await requestOpenAiTranscription(
        { accountId: "account", gatewayId: "gateway", gatewayToken: "gateway-token" },
        "recording.webm",
        { arrayBuffer: async () => new ArrayBuffer(0) },
      ),
    ).toMatchObject({
      status: "error",
      error: expect.objectContaining({
        message: "OpenAI transcription request failed with HTTP 401.",
      }),
    });
  });
});
