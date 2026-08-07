import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExaminationClientError,
  HttpExaminationQuestionClient,
} from "../src/examination-client.js";

const CONVERSATION_ID = "e570d451-98dc-4ba8-867b-735c652114b7";
const QUESTION_ID = "f6738fb0-70f0-4ea8-8b88-9c911cd1e68d";

afterEach(() => vi.restoreAllMocks());

describe("HttpExaminationQuestionClient", () => {
  it("authenticates, reads the current question, and completes it with revision evidence", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          status: "question",
          examinationSessionId: CONVERSATION_ID,
          examinationName: "Systems oral",
          subject: "Distributed systems",
          question: { id: QUESTION_ID, ordinal: 1, text: "Explain consensus." },
          questionCount: 1,
          revision: 0,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "complete",
          examinationSessionId: CONVERSATION_ID,
          examinationName: "Systems oral",
          subject: "Distributed systems",
          questionCount: 1,
          revision: 1,
        }),
      );
    const client = new HttpExaminationQuestionClient(
      "https://control.example.test",
      "agent-secret",
    );

    const current = await client.getCurrent(CONVERSATION_ID);
    if (current.status !== "question") expect.fail("Expected a question.");
    const completed = await client.completeCurrent(CONVERSATION_ID, {
      questionId: current.question.id,
      expectedRevision: current.revision,
      disposition: "answered_after_follow_up",
    });

    expect(completed.status).toBe("complete");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL(
        `/v1/integrations/examinations/conversations/${CONVERSATION_ID}/current-question`,
        "https://control.example.test",
      ),
      expect.objectContaining({
        headers: expect.any(Headers),
        signal: expect.any(AbortSignal),
      }),
    );
    const completionInit = fetchMock.mock.calls[1]?.[1];
    expect(new Headers(completionInit?.headers).get("Authorization")).toBe("Bearer agent-secret");
    expect(JSON.parse(String(completionInit?.body))).toEqual({
      questionId: QUESTION_ID,
      expectedRevision: 0,
      disposition: "answered_after_follow_up",
    });
  });

  it("rejects malformed responses without exposing response content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ secretProviderDetail: "do not expose" }),
    );
    const client = new HttpExaminationQuestionClient(
      "https://control.example.test",
      "agent-secret",
    );

    await expect(client.getCurrent(CONVERSATION_ID)).rejects.toMatchObject({
      code: "invalid_response",
    } satisfies Partial<ExaminationClientError>);
  });
});
