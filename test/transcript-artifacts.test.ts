import { describe, expect, it } from "vitest";

import {
  canonicalTranscript,
  canonicalTranscriptSchema,
  openAiTranscriptionResponseSchema,
  plainTextTranscript,
  transcriptArtifactKeys,
  webVtt,
} from "../src/worker/transcription/transcript-artifacts";

const response = openAiTranscriptionResponseSchema.parse({
  task: "transcribe",
  duration: 4.25,
  text: "Welcome. Thank you.",
  segments: [
    {
      type: "transcript.text.segment",
      id: "seg_0",
      start: 1.25,
      end: 2.5,
      speaker: "A",
      text: "Welcome.",
    },
    {
      type: "transcript.text.segment",
      id: "seg_1",
      start: 3,
      end: 4.25,
      speaker: "B",
      text: "Thank you.",
    },
  ],
});

const transcript = canonicalTranscriptSchema.parse(
  canonicalTranscript(
    { objectKey: "conversations/id/recording.webm", etag: "etag" },
    response,
    1234,
  ),
);

describe("transcript artifacts", () => {
  it("places all artifacts beside the source recording", () => {
    expect(transcriptArtifactKeys("conversations/id/recording.webm")).toMatchObject({
      status: "ok",
      value: {
        json: "conversations/id/transcript.v1.json",
        vtt: "conversations/id/transcript.v1.vtt",
        text: "conversations/id/transcript.v1.txt",
      },
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
        { speaker: "A", startMs: 1250, endMs: 2500, text: "Welcome.", confidence: null },
        { speaker: "B", startMs: 3000, endMs: 4250, text: "Thank you.", confidence: null },
      ],
    });
  });

  it("renders speaker-labelled VTT and text", () => {
    expect(webVtt(transcript)).toBe(
      "WEBVTT\n\n00:00:01.250 --> 00:00:02.500\n<v Speaker A>Welcome.\n\n" +
        "00:00:03.000 --> 00:00:04.250\n<v Speaker B>Thank you.\n",
    );
    expect(plainTextTranscript(transcript)).toBe(
      "[00:00:01] Speaker A: Welcome.\n\n[00:00:03] Speaker B: Thank you.\n",
    );
  });
});
