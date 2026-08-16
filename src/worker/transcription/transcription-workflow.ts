/** Durable post-recording transcription through AI Gateway and AssemblyAI. */
import { Result } from "better-result";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { presignRecordingGet } from "./presigned-recording-url";
import {
  transcriptionFailure,
  TranscriptionStageError,
  type TranscriptionErrorCategory,
  type TranscriptionErrorCode,
  type TranscriptionStage,
} from "./transcription-errors";
import {
  assemblyAiResponseSchema,
  canonicalTranscript,
  canonicalTranscriptSchema,
  plainTextTranscript,
  TRANSCRIPTION_MODEL,
  transcriptArtifactKeys,
  webVtt,
} from "./transcript-artifacts";

export interface TranscriptionWorkflowParams {
  readonly jobId: string;
  readonly conversationId: string;
  readonly objectKey: string;
  readonly etag: string;
}

interface StoredTranscriptResult {
  readonly jsonKey: string;
  readonly vttKey: string;
  readonly textKey: string;
}

const DERIVED_ARTIFACT_STEP_CONFIG = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

export class TranscriptionWorkflow extends WorkflowEntrypoint<Env, TranscriptionWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<TranscriptionWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<StoredTranscriptResult> {
    const params = event.payload;
    try {
      await step.do("verify recording and start job", async () => {
        const recording = await observeStage(
          params,
          "verify_recording",
          "recording_verification_failed",
          "r2_error",
          () => this.env.RECORDINGS.head(params.objectKey),
        );
        if (recording === null || recording.etag !== params.etag) {
          throw logStageFailure(
            params,
            "verify_recording",
            "source_recording_invalid",
            "validation_error",
            0,
          );
        }
        await observeStage(params, "start_job", "job_start_failed", "d1_error", () =>
          this.env.EXAM_DB.prepare(
            `UPDATE transcription_jobs
               SET status = 'running', started_at = COALESCE(started_at, ?), error_code = NULL
               WHERE id = ? AND source_object_key = ? AND source_etag = ?`,
          )
            .bind(Date.now(), params.jobId, params.objectKey, params.etag)
            .run(),
        );
        return { size: recording.size };
      });

      const canonical = await step.do(
        "transcribe and store canonical transcript",
        {
          retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
          timeout: "20 minutes",
        },
        async () => {
          const audioUrl = await observeStage(
            params,
            "presign_recording",
            "recording_presign_failed",
            "validation_error",
            () =>
              presignRecordingGet(
                {
                  accountId: this.env.R2_ACCOUNT_ID,
                  bucketName: this.env.R2_BUCKET_NAME,
                  accessKeyId: this.env.R2_ACCESS_KEY_ID,
                  secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
                },
                params.objectKey,
              ),
          );
          const raw = await observeStage(
            params,
            "inference",
            "inference_failed",
            "provider_error",
            () =>
              this.env.AI.run(
                TRANSCRIPTION_MODEL,
                {
                  audio_url: audioUrl,
                  speaker_labels: true,
                  speakers_expected: 2,
                },
                {
                  gateway: {
                    id: this.env.AI_GATEWAY_ID,
                    skipCache: true,
                    // Temporarily enabled for transcription debugging. Gateway logs may include
                    // the presigned audio URL, so disable this again after the investigation.
                    collectLog: true,
                  },
                },
              ),
          );
          const parsed = assemblyAiResponseSchema.safeParse(raw);
          if (!parsed.success) {
            throw logStageFailure(
              params,
              "inference",
              "inference_response_invalid",
              "invalid_response",
              0,
            );
          }
          const response = parsed.data;
          const generatedAt = Date.now();
          const jsonKey = transcriptArtifactKeys(params.objectKey).json;
          const source = { objectKey: params.objectKey, etag: params.etag };
          const metadata = { sourceEtag: params.etag, model: TRANSCRIPTION_MODEL };
          await observeStage(params, "canonical_write", "canonical_write_failed", "r2_error", () =>
            this.env.RECORDINGS.put(
              jsonKey,
              `${JSON.stringify(canonicalTranscript(source, response, generatedAt), null, 2)}\n`,
              {
                httpMetadata: { contentType: "application/json; charset=utf-8" },
                customMetadata: metadata,
              },
            ),
          );
          return { jsonKey };
        },
      );

      const vtt = await step.do(
        "create WebVTT transcript",
        DERIVED_ARTIFACT_STEP_CONFIG,
        async () => {
          const transcript = await observeStage(
            params,
            "vtt_read",
            "vtt_read_failed",
            "r2_error",
            () => readCanonicalTranscript(this.env.RECORDINGS, canonical.jsonKey),
          );
          const vttKey = transcriptArtifactKeys(params.objectKey).vtt;
          await observeStage(params, "vtt_write", "vtt_write_failed", "r2_error", () =>
            this.env.RECORDINGS.put(vttKey, webVtt(transcript), {
              httpMetadata: { contentType: "text/vtt; charset=utf-8" },
              customMetadata: { sourceEtag: params.etag, model: TRANSCRIPTION_MODEL },
            }),
          );
          return { vttKey };
        },
      );

      const text = await step.do(
        "create plaintext transcript",
        DERIVED_ARTIFACT_STEP_CONFIG,
        async () => {
          const transcript = await observeStage(
            params,
            "plaintext_read",
            "plaintext_read_failed",
            "r2_error",
            () => readCanonicalTranscript(this.env.RECORDINGS, canonical.jsonKey),
          );
          const textKey = transcriptArtifactKeys(params.objectKey).text;
          await observeStage(params, "plaintext_write", "plaintext_write_failed", "r2_error", () =>
            this.env.RECORDINGS.put(textKey, plainTextTranscript(transcript), {
              httpMetadata: { contentType: "text/plain; charset=utf-8" },
              customMetadata: { sourceEtag: params.etag, model: TRANSCRIPTION_MODEL },
            }),
          );
          return { textKey };
        },
      );

      const stored = { jsonKey: canonical.jsonKey, vttKey: vtt.vttKey, textKey: text.textKey };

      await step.do("complete transcription job", async () => {
        await observeStage(params, "complete_job", "job_completion_failed", "d1_error", () =>
          this.env.EXAM_DB.prepare(
            `UPDATE transcription_jobs
               SET status = 'complete', transcript_json_key = ?, transcript_vtt_key = ?,
                   transcript_text_key = ?, completed_at = ?, error_code = NULL
               WHERE id = ?`,
          )
            .bind(stored.jsonKey, stored.vttKey, stored.textKey, Date.now(), params.jobId)
            .run(),
        );
        return { completed: true };
      });

      return stored;
    } catch (cause) {
      const failure = transcriptionFailure(cause);
      console.error({
        kind: "transcription_workflow_failed",
        jobId: params.jobId,
        conversationId: params.conversationId,
        model: TRANSCRIPTION_MODEL,
        stage: failure.stage,
        category: failure.category,
        errorCode: failure.errorCode,
      });
      await step.do("record transcription failure", async () => {
        await this.env.EXAM_DB.prepare(
          `UPDATE transcription_jobs
           SET status = 'failed', error_code = ?, completed_at = ?
           WHERE id = ?`,
        )
          .bind(failure.errorCode, Date.now(), params.jobId)
          .run();
        return { failed: true };
      });
      // Do not preserve provider errors because they can contain the presigned URL.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Transcription workflow failed (${failure.errorCode}).`);
    }
  }
}

async function readCanonicalTranscript(bucket: R2Bucket, key: string) {
  const object = await bucket.get(key);
  if (object === null) throw new Error("The canonical transcript is missing.");
  return canonicalTranscriptSchema.parse(await object.json());
}

async function observeStage<T>(
  params: TranscriptionWorkflowParams,
  stage: TranscriptionStage,
  errorCode: TranscriptionErrorCode,
  category: TranscriptionErrorCategory,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const result = await Result.tryPromise({ try: operation, catch: () => undefined });
  if (!result.isOk()) {
    throw logStageFailure(params, stage, errorCode, category, Date.now() - startedAt);
  }
  return result.value;
}

function logStageFailure(
  params: TranscriptionWorkflowParams,
  stage: TranscriptionStage,
  errorCode: TranscriptionErrorCode,
  category: TranscriptionErrorCategory,
  durationMs: number,
): TranscriptionStageError {
  console.error({
    kind: "transcription_step_error",
    jobId: params.jobId,
    conversationId: params.conversationId,
    model: TRANSCRIPTION_MODEL,
    stage,
    category,
    errorCode,
    durationMs,
  });
  return new TranscriptionStageError(stage, errorCode, category);
}
