import { transcriptSchema } from "@ai-oral-exam/conversation-contract";
import { describe, expect, it } from "vitest";

import {
  createTranscript,
  openAiTranscriptionResponseSchema,
  transcriptArtifactKey,
} from "../src/worker/transcription/transcript-artifacts";

const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
      text: " Welcome. ",
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

describe("transcript artifact", () => {
  it("uses one versioned JSON object beside the source recording", () => {
    expect(transcriptArtifactKey("conversations/id/recording.webm")).toMatchObject({
      status: "ok",
      value: "conversations/id/transcript.v1.json",
    });
  });

  it("creates timed turns with semantic participant roles", () => {
    const transcript = transcriptSchema.parse(
      createTranscript(
        conversationId,
        { objectKey: "conversations/id/recording.webm", etag: "etag" },
        response,
        1234,
      ),
    );

    expect(transcript).toEqual({
      schemaVersion: 1,
      conversationId,
      source: {
        objectKey: "conversations/id/recording.webm",
        etag: "etag",
        durationMs: 4250,
      },
      transcription: {
        provider: "openai",
        model: "gpt-4o-transcribe-diarize",
        generatedAt: 1234,
        languageCode: null,
      },
      participants: [
        {
          id: "examiner",
          role: "examiner",
          roleAssignment: "first-speaker-heuristic",
          displayName: "Examiner",
          sourceSpeakerLabel: "A",
        },
        {
          id: "student",
          role: "student",
          roleAssignment: "first-speaker-heuristic",
          displayName: "Student",
          sourceSpeakerLabel: "B",
        },
      ],
      turns: [
        {
          id: "turn-0001",
          participantId: "examiner",
          startMs: 1250,
          endMs: 2500,
          text: "Welcome.",
          confidence: null,
        },
        {
          id: "turn-0002",
          participantId: "student",
          startMs: 3000,
          endMs: 4250,
          text: "Thank you.",
          confidence: null,
        },
      ],
    });
  });

  it("rejects invalid timing and dangling participant references", () => {
    const transcript = createTranscript(
      conversationId,
      { objectKey: "conversations/id/recording.webm", etag: "etag" },
      response,
      1234,
    );

    expect(
      transcriptSchema.safeParse({
        ...transcript,
        turns: [{ ...transcript.turns[0], participantId: "missing", endMs: 5000 }],
      }).success,
    ).toBe(false);
  });
});
