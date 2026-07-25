import { describe, expect, it, vi } from "vitest";

import { createAssistant } from "../src/assistant.js";
import type { ExaminationQuestionClient } from "../src/examination-client.js";

describe("oral examination assistant", () => {
  it("loads the examiner markdown prompt and exposes only the authoritative start tool", () => {
    const client: ExaminationQuestionClient = {
      getCurrent: vi.fn(),
      completeCurrent: vi.fn(),
    };
    const assistant = createAssistant({
      client,
      conversationId: "e570d451-98dc-4ba8-867b-735c652114b7",
    });

    expect(String(assistant.instructions)).toContain("Current Application Tools and MVP Scope");
    expect(String(assistant.instructions)).toContain("human examiner");
    expect(Object.keys(assistant.toolCtx.functionTools)).toEqual([
      "get_current_examination_question",
    ]);
  });

  it("keeps a tool-free assistant for explicit synthetic console jobs", () => {
    const assistant = createAssistant();
    expect(Object.keys(assistant.toolCtx.functionTools)).toEqual([]);
  });
});
