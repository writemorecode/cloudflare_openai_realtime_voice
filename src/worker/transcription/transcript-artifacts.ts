/** Validates OpenAI output and creates provider-neutral transcript artifacts. */
import { Result } from "better-result";
import { z } from "zod";

export const TRANSCRIPTION_MODEL = "gpt-4o-transcribe-diarize";

const openAiSegmentSchema = z.object({
  type: z.literal("transcript.text.segment"),
  id: z.string().min(1),
  end: z.number().nonnegative(),
  speaker: z.string().min(1),
  start: z.number().nonnegative(),
  text: z.string(),
});

export const openAiTranscriptionResponseSchema = z.object({
  task: z.literal("transcribe"),
  duration: z.number().nonnegative(),
  text: z.string(),
  segments: z.array(openAiSegmentSchema),
});

export type OpenAiTranscriptionResponse = z.infer<typeof openAiTranscriptionResponseSchema>;

const canonicalTimedTextSchema = z.object({
  confidence: z.number().min(0).max(1).nullable(),
  endMs: z.number().int().nonnegative(),
  speaker: z.string().min(1).nullable(),
  startMs: z.number().int().nonnegative(),
  text: z.string(),
});

export const canonicalTranscriptSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({ objectKey: z.string().min(1), etag: z.string().min(1) }),
  transcription: z.object({
    provider: z.literal("openai"),
    model: z.literal(TRANSCRIPTION_MODEL),
    generatedAt: z.number().int().nonnegative(),
    languageCode: z.string().nullable(),
    languageConfidence: z.number().min(0).max(1).nullable(),
    confidence: z.number().min(0).max(1).nullable(),
  }),
  text: z.string(),
  utterances: z.array(canonicalTimedTextSchema),
  words: z.array(canonicalTimedTextSchema),
});

export type CanonicalTranscript = z.infer<typeof canonicalTranscriptSchema>;
type CanonicalTimedText = z.infer<typeof canonicalTimedTextSchema>;

export interface TranscriptSource {
  readonly objectKey: string;
  readonly etag: string;
}

export interface TranscriptArtifactKeys {
  readonly json: string;
  readonly vtt: string;
  readonly text: string;
}

export function transcriptArtifactKeys(sourceObjectKey: string) {
  const separator = sourceObjectKey.lastIndexOf("/");
  if (separator < 1) return Result.err(new Error("The recording object key has no parent prefix."));
  const prefix = sourceObjectKey.slice(0, separator);
  return Result.ok<TranscriptArtifactKeys>({
    json: `${prefix}/transcript.v1.json`,
    vtt: `${prefix}/transcript.v1.vtt`,
    text: `${prefix}/transcript.v1.txt`,
  });
}

export function canonicalTranscript(
  source: TranscriptSource,
  response: OpenAiTranscriptionResponse,
  generatedAt: number,
): CanonicalTranscript {
  return {
    schemaVersion: 1,
    source,
    transcription: {
      provider: "openai",
      model: TRANSCRIPTION_MODEL,
      generatedAt,
      languageCode: null,
      languageConfidence: null,
      confidence: null,
    },
    text: response.text,
    utterances: response.segments.map(canonicalTimedText),
    words: [],
  };
}

export function webVtt(transcript: CanonicalTranscript): string {
  const cues = transcriptCues(transcript);
  const body = cues
    .map(
      (cue) =>
        `${formatVttTimestamp(cue.startMs)} --> ${formatVttTimestamp(cue.endMs)}\n<v ${voiceName(cue.speaker)}>${escapeVtt(cue.text)}`,
    )
    .join("\n\n");
  return body.length === 0 ? "WEBVTT\n" : `WEBVTT\n\n${body}\n`;
}

export function plainTextTranscript(transcript: CanonicalTranscript): string {
  const cues = transcriptCues(transcript);
  if (cues.length === 0) return `${transcript.text.trim()}\n`;
  return `${cues
    .map(
      (cue) =>
        `[${formatPlainTimestamp(cue.startMs)}] ${speakerName(cue.speaker)}: ${cue.text.trim()}`,
    )
    .join("\n\n")}\n`;
}

function transcriptCues(transcript: CanonicalTranscript): readonly CanonicalTimedText[] {
  return transcript.utterances.length > 0 ? transcript.utterances : transcript.words;
}

function canonicalTimedText(value: z.infer<typeof openAiSegmentSchema>): CanonicalTimedText {
  return {
    speaker: value.speaker,
    startMs: Math.round(value.start * 1000),
    endMs: Math.round(value.end * 1000),
    text: value.text,
    confidence: null,
  };
}

function formatVttTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(remainder, 3)}`;
}

function formatPlainTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}`;
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

function speakerName(speaker: string | null): string {
  return speaker === null ? "Speaker" : `Speaker ${speaker}`;
}

function voiceName(speaker: string | null): string {
  return speakerName(speaker).replaceAll(/[<&>]/g, "");
}

function escapeVtt(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
