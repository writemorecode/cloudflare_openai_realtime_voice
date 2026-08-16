/** Durable post-recording transcription through AI Gateway and OpenAI. */
import { Result } from "better-result";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import {
  isSupportedTranscriptionFileSize,
  MAXIMUM_TRANSCRIPTION_FILE_BYTES,
  requestOpenAiTranscription,
} from "./openai-transcription";
import {
  transcriptionFailure,
  TranscriptionStageError,
  type TranscriptionErrorCategory,
  type TranscriptionErrorCode,
  type TranscriptionStage,
} from "./transcription-errors";
import {
  canonicalTranscript,
  canonicalTranscriptSchema,
  openAiTranscriptionResponseSchema,
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
    const workflow = await Result.tryPromise({
      try: async () => {
        await step.do("verify recording and start job", async () => {
          const recording = await runStage(
            params,
            "verify_recording",
            "recording_verification_failed",
            "r2_error",
            () => this.env.RECORDINGS.head(params.objectKey),
          );
          if (recording === null || recording.etag !== params.etag) {
            return failStep(
              createLoggedStageFailure(
                params,
                "verify_recording",
                "source_recording_invalid",
                "validation_error",
                0,
              ),
            );
          }
          if (!isSupportedTranscriptionFileSize(recording.size)) {
            return failStep(
              createLoggedStageFailure(
                params,
                "verify_recording",
                "source_recording_too_large",
                "validation_error",
                0,
                recordingSizeDetails(recording.size),
              ),
            );
          }
          await runStage(params, "start_job", "job_start_failed", "d1_error", () =>
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
            const recording = await runStage(
              params,
              "read_recording",
              "recording_read_failed",
              "r2_error",
              () => this.env.RECORDINGS.get(params.objectKey),
            );
            if (recording === null) {
              return failStep(
                createLoggedStageFailure(
                  params,
                  "read_recording",
                  "source_recording_invalid",
                  "validation_error",
                  0,
                ),
              );
            }
            if (!isSupportedTranscriptionFileSize(recording.size)) {
              return failStep(
                createLoggedStageFailure(
                  params,
                  "read_recording",
                  "source_recording_too_large",
                  "validation_error",
                  0,
                  recordingSizeDetails(recording.size),
                ),
              );
            }
            const raw = await runStage(
              params,
              "inference",
              "inference_failed",
              "provider_error",
              () =>
                requestOpenAiTranscription(
                  {
                    accountId: this.env.AI_GATEWAY_ACCOUNT_ID,
                    gatewayId: this.env.AI_GATEWAY_ID,
                    gatewayToken: this.env.AI_GATEWAY_TOKEN,
                  },
                  params.objectKey,
                  recording,
                ),
            );
            // The gateway uses Result for expected HTTP/provider failures. Translate
            // that error into the workflow's stable, safe-to-persist failure type.
            const responseResult = raw.mapError(() =>
              createLoggedStageFailure(
                params,
                "inference",
                "inference_failed",
                "provider_error",
                0,
              ),
            );
            if (!responseResult.isOk()) return failStep(responseResult.error);

            const parsed = openAiTranscriptionResponseSchema.safeParse(responseResult.value);
            if (!parsed.success) {
              return failStep(
                createLoggedStageFailure(
                  params,
                  "inference",
                  "inference_response_invalid",
                  "invalid_response",
                  0,
                ),
              );
            }
            const response = parsed.data;
            const generatedAt = Date.now();
            const keys = transcriptArtifactKeys(params.objectKey);
            if (!keys.isOk()) return failStep(keys.error);
            const jsonKey = keys.value.json;
            const source = { objectKey: params.objectKey, etag: params.etag };
            const metadata = { sourceEtag: params.etag, model: TRANSCRIPTION_MODEL };
            await runStage(params, "canonical_write", "canonical_write_failed", "r2_error", () =>
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
            const transcript = await runStage(
              params,
              "vtt_read",
              "vtt_read_failed",
              "r2_error",
              () => readCanonicalTranscript(this.env.RECORDINGS, canonical.jsonKey),
            );
            const keys = transcriptArtifactKeys(params.objectKey);
            if (!keys.isOk()) return failStep(keys.error);
            const vttKey = keys.value.vtt;
            await runStage(params, "vtt_write", "vtt_write_failed", "r2_error", () =>
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
            const transcript = await runStage(
              params,
              "plaintext_read",
              "plaintext_read_failed",
              "r2_error",
              () => readCanonicalTranscript(this.env.RECORDINGS, canonical.jsonKey),
            );
            const keys = transcriptArtifactKeys(params.objectKey);
            if (!keys.isOk()) return failStep(keys.error);
            const textKey = keys.value.text;
            await runStage(params, "plaintext_write", "plaintext_write_failed", "r2_error", () =>
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
          await runStage(params, "complete_job", "job_completion_failed", "d1_error", () =>
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
      },
      catch: (cause) => cause,
    });
    if (workflow.isOk()) return workflow.value;

    const failure = transcriptionFailure(workflow.error);
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
    // Do not preserve provider errors because they can contain sensitive response details.
    return failStep(new Error(`Transcription workflow failed (${failure.errorCode}).`));
  }
}

async function readCanonicalTranscript(bucket: R2Bucket, key: string) {
  const object = await bucket.get(key);
  if (object === null) return failStep(new Error("The canonical transcript is missing."));
  return canonicalTranscriptSchema.parse(await object.json());
}

/**
 * Runs one external operation and maps a rejected promise to the stable error
 * contract for its workflow stage. The returned value is deliberately unwrapped
 * here because Cloudflare Workflow steps use rejected promises to trigger retries.
 */
async function runStage<T>(
  params: TranscriptionWorkflowParams,
  stage: TranscriptionStage,
  errorCode: TranscriptionErrorCode,
  category: TranscriptionErrorCategory,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const stageResult = (
    await Result.tryPromise({
      try: operation,
      // Provider and R2 failures may contain response data, so do not log causes.
      catch: () => undefined,
    })
  ).mapError(() =>
    createLoggedStageFailure(params, stage, errorCode, category, Date.now() - startedAt),
  );

  if (stageResult.isOk()) return stageResult.value;
  return Promise.reject(stageResult.error);
}

/**
 * Bridges typed Result failures to Cloudflare Workflow's exception-based step API.
 * Rejecting lets the workflow runtime apply its configured retry policy.
 */
function failStep(cause: unknown): Promise<never> {
  return Promise.reject(cause);
}

/** Records only safe, structured metadata; the original operation error is omitted. */
function createLoggedStageFailure(
  params: TranscriptionWorkflowParams,
  stage: TranscriptionStage,
  errorCode: TranscriptionErrorCode,
  category: TranscriptionErrorCategory,
  durationMs: number,
  details: Readonly<Record<string, number>> = {},
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
    ...details,
  });
  return new TranscriptionStageError(stage, errorCode, category);
}

function recordingSizeDetails(recordingSizeBytes: number): Readonly<Record<string, number>> {
  return {
    recordingSizeBytes,
    maximumRecordingSizeBytes: MAXIMUM_TRANSCRIPTION_FILE_BYTES,
  };
}
