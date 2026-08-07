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
});
