import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationStateTag, HttpConversationApi } from "../src";

const validState = {
  conversationId: "12345678-1234-8234-9234-123456789abc",
  state: ConversationStateTag.Created,
  revision: 0,
  enteredAt: 1,
  updatedAt: 1,
  activeDeadlineAt: null,
  transport: { status: "idle" },
  artifact: { status: "pending" },
} as const;

afterEach(() => vi.unstubAllGlobals());

function resolved<T>(value: T) {
  return vi.fn(async () => value);
}

function rejected(error: unknown) {
  return vi.fn(async () => Promise.reject(error));
}

describe("HttpConversationApi public contract", () => {
  it("returns responses that satisfy the foundation contract", async () => {
    const fetch = resolved(Response.json(validState));
    vi.stubGlobal("fetch", fetch);
    const api = new HttpConversationApi({ baseUrl: "https://example.test" });

    await expect(api.getState(validState.conversationId)).resolves.toEqual({
      status: "ok",
      value: validState,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL(`/v1/conversations/${validState.conversationId}/state`, "https://example.test"),
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("rejects malformed control-plane responses before they reach the application", async () => {
    vi.stubGlobal("fetch", resolved(Response.json({ ...validState, revision: "not-a-number" })));
    const api = new HttpConversationApi({ baseUrl: "https://example.test" });

    await expect(api.getState(validState.conversationId)).resolves.toMatchObject({
      status: "error",
      error: { code: "invalid_response" },
    });
  });

  it("returns typed HTTP problem details as an error value", async () => {
    vi.stubGlobal(
      "fetch",
      resolved(Response.json({ detail: "Conversation not found." }, { status: 404 })),
    );
    const api = new HttpConversationApi({ baseUrl: "https://example.test" });

    await expect(api.getState(validState.conversationId)).resolves.toMatchObject({
      status: "error",
      error: {
        code: "http_request_failed",
        message: "Conversation not found.",
      },
    });
  });

  it("returns network failures as error values", async () => {
    vi.stubGlobal("fetch", rejected(new TypeError("offline")));
    const api = new HttpConversationApi({ baseUrl: "https://example.test" });

    await expect(api.getState(validState.conversationId)).resolves.toMatchObject({
      status: "error",
      error: { code: "request_failed" },
    });
  });

  it("exchanges SDP and executes Realtime function tools through authenticated app routes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response("answer-sdp", { headers: { "Content-Type": "application/sdp" } }),
      )
      .mockResolvedValueOnce(Response.json({ status: "complete", revision: 2 }));
    vi.stubGlobal("fetch", fetch);
    const api = new HttpConversationApi({ baseUrl: "https://example.test" });

    await expect(api.createRealtimeCall(validState.conversationId, "offer-sdp")).resolves.toEqual({
      status: "ok",
      value: "answer-sdp",
    });
    await expect(
      api.executeRealtimeTool(
        validState.conversationId,
        "complete_current_examination_question",
        JSON.stringify({
          questionId: crypto.randomUUID(),
          expectedRevision: 1,
          disposition: "answered",
        }),
      ),
    ).resolves.toMatchObject({ status: "ok", value: { status: "complete", revision: 2 } });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL(
        `/v1/conversations/${validState.conversationId}/realtime-call`,
        "https://example.test",
      ),
      expect.objectContaining({ method: "POST", body: "offer-sdp", credentials: "same-origin" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL(
        `/v1/conversations/${validState.conversationId}/tools/complete_current_examination_question`,
        "https://example.test",
      ),
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
  });

  it("uses the R2 multipart recording endpoints in order", async () => {
    const upload = {
      recordingId: "upload-1",
      objectKey: `conversations/${validState.conversationId}/recording.webm`,
      uploadId: "upload-1",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(upload))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ partNumber: 1, etag: "etag-part-1" }))
      .mockResolvedValueOnce(Response.json({ objectKey: upload.objectKey, etag: "etag-complete" }))
      .mockResolvedValueOnce(Response.json({ ...validState, state: "completed", revision: 8 }));
    vi.stubGlobal("fetch", fetch);
    const api = new HttpConversationApi({ baseUrl: "https://example.test" });

    await expect(
      api.beginRecording(validState.conversationId, "audio/webm;codecs=opus"),
    ).resolves.toMatchObject({
      status: "ok",
      value: upload,
    });
    await expect(
      api.beginRecordingUpload(validState.conversationId, upload),
    ).resolves.toMatchObject({ status: "ok" });
    const part = await api.uploadRecordingPart(
      validState.conversationId,
      upload,
      1,
      new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
    );
    expect(part).toMatchObject({ status: "ok", value: { partNumber: 1, etag: "etag-part-1" } });
    if (!part.isOk()) expect.fail("Expected the recording part to upload.");
    await expect(
      api.completeRecordingUpload(validState.conversationId, upload, [part.value]),
    ).resolves.toMatchObject({ status: "ok", value: { state: "completed", revision: 8 } });
  });
});
