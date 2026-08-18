import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("transcription job schema", () => {
  it("stores only the application transcript artifact key", async () => {
    const columns = await env.EXAM_DB.prepare("PRAGMA table_info(transcription_jobs)").all<{
      name: string;
    }>();
    const names = columns.results.map((column) => column.name);

    expect(names).toContain("transcript_key");
    expect(names).not.toContain("transcript_json_key");
    expect(names).not.toContain("transcript_vtt_key");
    expect(names).not.toContain("transcript_text_key");
  });
});
