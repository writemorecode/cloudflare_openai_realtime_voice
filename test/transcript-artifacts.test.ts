import { describe, expect, it } from "vitest";

import {
  assemblyAiResponseSchema,
  canonicalTranscript,
  plainTextTranscript,
  transcriptArtifactKeys,
  webVtt,
} from "../src/worker/transcription/transcript-artifacts";

const response = assemblyAiResponseSchema.parse({
  state: "Completed",
  result: {
    confidence: 0.95,
    language_code: "en",
    language_confidence: 0.99,
    text: "Welcome. Thank you.",
    utterances: [
      { confidence: 0.98, start: 1250, end: 2500, speaker: "A", text: "Welcome." },
      { confidence: 0.92, start: 3000, end: 4250, speaker: "B", text: "Thank you." },
    ],
    words: [
      { confidence: 0.98, start: 1250, end: 2500, speaker: "A", text: "Welcome." },
      { confidence: 0.92, start: 3000, end: 4250, speaker: "B", text: "Thank you." },
    ],
  },
});

describe("transcript artifacts", () => {
  it("places all artifacts beside the source recording", () => {
    expect(transcriptArtifactKeys("conversations/id/recording.webm")).toEqual({
      json: "conversations/id/transcript.v1.json",
      vtt: "conversations/id/transcript.v1.vtt",
      text: "conversations/id/transcript.v1.txt",
    });
  });

  it("preserves diarized timestamps in canonical JSON", () => {
    expect(
      canonicalTranscript(
        { objectKey: "conversations/id/recording.webm", etag: "etag" },
        response,
        1234,
      ),
    ).toMatchObject({
      schemaVersion: 1,
      source: { objectKey: "conversations/id/recording.webm", etag: "etag" },
      utterances: [
        { speaker: "A", startMs: 1250, endMs: 2500, text: "Welcome.", confidence: 0.98 },
        { speaker: "B", startMs: 3000, endMs: 4250, text: "Thank you.", confidence: 0.92 },
      ],
    });
  });

  it("renders speaker-labelled VTT and text", () => {
    expect(webVtt(response)).toBe(
      "WEBVTT\n\n00:00:01.250 --> 00:00:02.500\n<v Speaker A>Welcome.\n\n" +
        "00:00:03.000 --> 00:00:04.250\n<v Speaker B>Thank you.\n",
    );
    expect(plainTextTranscript(response)).toBe(
      "[00:00:01] Speaker A: Welcome.\n\n[00:00:03] Speaker B: Thank you.\n",
    );
  });
});
