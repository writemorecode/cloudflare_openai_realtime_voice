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

describe("HttpConversationApi public contract", () => {
  it("returns responses that satisfy the foundation contract", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(validState));
    vi.stubGlobal("fetch", fetch);
    const api = new HttpConversationApi({ baseUrl: "https://example.test" });

    await expect(api.getState(validState.conversationId)).resolves.toEqual(validState);
    expect(fetch).toHaveBeenCalledWith(
      new URL(`/v1/conversations/${validState.conversationId}/state`, "https://example.test"),
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("rejects malformed control-plane responses before they reach the application", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...validState, revision: "not-a-number" })),
    );
    const api = new HttpConversationApi({ baseUrl: "https://example.test" });

    await expect(api.getState(validState.conversationId)).rejects.toThrow();
  });
});
