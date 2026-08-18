/** Validates provider output and creates the application's transcript artifact. */
import {
  transcriptSchema,
  type Transcript,
  type TranscriptParticipant,
} from "@ai-oral-exam/conversation-contract";
import { Result } from "better-result";
import { z } from "zod";

export const TRANSCRIPTION_MODEL = "gpt-4o-transcribe-diarize";

const openAiSegmentSchema = z
  .object({
    type: z.literal("transcript.text.segment"),
    id: z.string().min(1),
    end: z.number().nonnegative(),
    speaker: z.string().min(1),
    start: z.number().nonnegative(),
    text: z.string(),
  })
  .refine((segment) => segment.end >= segment.start, {
    message: "Transcript segment end time must not precede its start time.",
    path: ["end"],
  });

export const openAiTranscriptionResponseSchema = z.object({
  task: z.literal("transcribe"),
  duration: z.number().nonnegative(),
  text: z.string(),
  segments: z.array(openAiSegmentSchema),
});

export type OpenAiTranscriptionResponse = z.infer<typeof openAiTranscriptionResponseSchema>;

export interface TranscriptSource {
  readonly objectKey: string;
  readonly etag: string;
}

/** Returns the only transcript artifact key stored beside a recording. */
export function transcriptArtifactKey(sourceObjectKey: string) {
  const separator = sourceObjectKey.lastIndexOf("/");
  if (separator < 1) return Result.err(new Error("The recording object key has no parent prefix."));
  return Result.ok(`${sourceObjectKey.slice(0, separator)}/transcript.v1.json`);
}

/** Converts diarized provider output into the stable application transcript contract. */
export function createTranscript(
  conversationId: string,
  source: TranscriptSource,
  response: OpenAiTranscriptionResponse,
  generatedAt: number,
): Transcript {
  const segments = response.segments
    .filter((segment) => segment.text.trim().length > 0)
    .toSorted((left, right) => left.start - right.start);
  const speakerLabels = [...new Set(segments.map((segment) => segment.speaker))];
  const participants = speakerLabels.map(transcriptParticipant);
  const participantBySpeaker = new Map(
    participants.map((participant) => [participant.sourceSpeakerLabel, participant.id]),
  );
  const durationMs = Math.max(
    Math.ceil(response.duration * 1000),
    ...segments.map((segment) => Math.round(segment.end * 1000)),
  );

  return transcriptSchema.parse({
    schemaVersion: 1,
    conversationId,
    source: { ...source, durationMs },
    transcription: {
      provider: "openai",
      model: TRANSCRIPTION_MODEL,
      generatedAt,
      languageCode: null,
    },
    participants,
    turns: segments.map((segment, index) => ({
      id: `turn-${String(index + 1).padStart(4, "0")}`,
      participantId: participantBySpeaker.get(segment.speaker),
      startMs: Math.round(segment.start * 1000),
      endMs: Math.round(segment.end * 1000),
      text: segment.text.trim(),
      confidence: null,
    })),
  });
}

function transcriptParticipant(sourceSpeakerLabel: string, index: number): TranscriptParticipant {
  if (index === 0) {
    return {
      id: "examiner",
      role: "examiner",
      roleAssignment: "first-speaker-heuristic",
      displayName: "Examiner",
      sourceSpeakerLabel,
    };
  }
  if (index === 1) {
    return {
      id: "student",
      role: "student",
      roleAssignment: "first-speaker-heuristic",
      displayName: "Student",
      sourceSpeakerLabel,
    };
  }
  return {
    id: `speaker-${index + 1}`,
    role: "unknown",
    roleAssignment: "unassigned",
    displayName: `Speaker ${index + 1}`,
    sourceSpeakerLabel,
  };
}
