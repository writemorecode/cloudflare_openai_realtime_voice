const TRANSCRIPTION_STAGES = [
  "verify_recording",
  "start_job",
  "read_recording",
  "inference",
  "canonical_write",
  "vtt_read",
  "vtt_write",
  "plaintext_read",
  "plaintext_write",
  "complete_job",
] as const;

const TRANSCRIPTION_ERROR_CODES = [
  "source_recording_invalid",
  "source_recording_too_large",
  "recording_verification_failed",
  "job_start_failed",
  "recording_read_failed",
  "inference_failed",
  "inference_response_invalid",
  "canonical_write_failed",
  "vtt_read_failed",
  "vtt_write_failed",
  "plaintext_read_failed",
  "plaintext_write_failed",
  "job_completion_failed",
  "transcription_failed",
] as const;

const TRANSCRIPTION_ERROR_CATEGORIES = [
  "validation_error",
  "provider_error",
  "invalid_response",
  "r2_error",
  "d1_error",
  "unexpected_error",
] as const;

export type TranscriptionStage = (typeof TRANSCRIPTION_STAGES)[number];
export type TranscriptionErrorCode = (typeof TRANSCRIPTION_ERROR_CODES)[number];
export type TranscriptionErrorCategory = (typeof TRANSCRIPTION_ERROR_CATEGORIES)[number];

export interface TranscriptionFailure {
  readonly stage: TranscriptionStage | "unknown";
  readonly errorCode: TranscriptionErrorCode;
  readonly category: TranscriptionErrorCategory;
}

const ERROR_MARKER_PATTERN =
  /^Transcription stage failed \[stage=([^;]+);errorCode=([^;]+);category=([^\]]+)\]\.$/;

export class TranscriptionStageError extends Error {
  constructor(
    readonly stage: TranscriptionStage,
    readonly errorCode: TranscriptionErrorCode,
    readonly category: TranscriptionErrorCategory,
  ) {
    super(
      `Transcription stage failed [stage=${stage};errorCode=${errorCode};category=${category}].`,
    );
    this.name = "TranscriptionStageError";
  }
}

export function transcriptionFailure(cause: unknown): TranscriptionFailure {
  if (cause instanceof TranscriptionStageError) return cause;
  const message = errorMessage(cause);
  const match = ERROR_MARKER_PATTERN.exec(message);
  if (match !== null) {
    const [, stage, errorCode, category] = match;
    if (
      isMember(TRANSCRIPTION_STAGES, stage) &&
      isMember(TRANSCRIPTION_ERROR_CODES, errorCode) &&
      isMember(TRANSCRIPTION_ERROR_CATEGORIES, category)
    ) {
      return { stage, errorCode, category };
    }
  }
  return {
    stage: "unknown",
    errorCode: "transcription_failed",
    category: "unexpected_error",
  };
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause !== "object" || cause === null || !("message" in cause)) return "";
  return typeof cause.message === "string" ? cause.message : "";
}

function isMember<const Values extends readonly string[]>(
  values: Values,
  candidate: string | undefined,
): candidate is Values[number] {
  return candidate !== undefined && values.includes(candidate);
}
