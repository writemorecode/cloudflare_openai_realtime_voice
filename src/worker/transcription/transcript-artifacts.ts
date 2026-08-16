/** Validates AssemblyAI output and creates provider-neutral transcript artifacts. */
import { z } from "zod";

export const TRANSCRIPTION_MODEL = "assemblyai/universal-3-pro";

const timedTextSchema = z.object({
  confidence: z.number().min(0).max(1).nullable(),
  end: z.number().int().nonnegative(),
  speaker: z.string().min(1).nullable(),
  start: z.number().int().nonnegative(),
  text: z.string(),
});

export const assemblyAiResponseSchema = z.object({
  result: z.object({
    confidence: z.number().min(0).max(1).nullable(),
    language_code: z.string().nullable(),
    language_confidence: z.number().min(0).max(1).nullable(),
    text: z.string(),
    utterances: z.array(timedTextSchema).nullable(),
    words: z.array(timedTextSchema).nullable(),
  }),
  state: z.literal("Completed"),
});

export type AssemblyAiResponse = z.infer<typeof assemblyAiResponseSchema>;
type TimedText = z.infer<typeof timedTextSchema>;

export interface TranscriptSource {
  readonly objectKey: string;
  readonly etag: string;
}

export interface TranscriptArtifactKeys {
  readonly json: string;
  readonly vtt: string;
  readonly text: string;
}

export function transcriptArtifactKeys(sourceObjectKey: string): TranscriptArtifactKeys {
  const separator = sourceObjectKey.lastIndexOf("/");
  if (separator < 1) throw new Error("The recording object key has no parent prefix.");
  const prefix = sourceObjectKey.slice(0, separator);
  return {
    json: `${prefix}/transcript.v1.json`,
    vtt: `${prefix}/transcript.v1.vtt`,
    text: `${prefix}/transcript.v1.txt`,
  };
}

export function canonicalTranscript(
  source: TranscriptSource,
  response: AssemblyAiResponse,
  generatedAt: number,
): object {
  return {
    schemaVersion: 1,
    source,
    transcription: {
      provider: "assemblyai",
      model: TRANSCRIPTION_MODEL,
      generatedAt,
      languageCode: response.result.language_code,
      languageConfidence: response.result.language_confidence,
      confidence: response.result.confidence,
    },
    text: response.result.text,
    utterances: response.result.utterances?.map(canonicalTimedText) ?? [],
    words: response.result.words?.map(canonicalTimedText) ?? [],
  };
}

export function webVtt(response: AssemblyAiResponse): string {
  const cues = transcriptCues(response);
  const body = cues
    .map(
      (cue) =>
        `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}\n<v ${voiceName(cue.speaker)}>${escapeVtt(cue.text)}`,
    )
    .join("\n\n");
  return body.length === 0 ? "WEBVTT\n" : `WEBVTT\n\n${body}\n`;
}

export function plainTextTranscript(response: AssemblyAiResponse): string {
  const cues = transcriptCues(response);
  if (cues.length === 0) return `${response.result.text.trim()}\n`;
  return `${cues
    .map(
      (cue) =>
        `[${formatPlainTimestamp(cue.start)}] ${speakerName(cue.speaker)}: ${cue.text.trim()}`,
    )
    .join("\n\n")}\n`;
}

function transcriptCues(response: AssemblyAiResponse): readonly TimedText[] {
  const utterances = response.result.utterances;
  if (utterances !== null && utterances.length > 0) return utterances;
  const words = response.result.words;
  return words === null ? [] : words;
}

function canonicalTimedText(value: TimedText): object {
  return {
    speaker: value.speaker,
    startMs: value.start,
    endMs: value.end,
    text: value.text,
    confidence: value.confidence,
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
