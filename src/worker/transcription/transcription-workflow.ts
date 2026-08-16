/** Durable post-recording transcription through AI Gateway and OpenAI. */
import { Result } from "better-result";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { requestOpenAiTranscription } from "./openai-transcription";
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
          const recording = await observeStage(
            params,
            "verify_recording",
            "recording_verification_failed",
            "r2_error",
            () => this.env.RECORDINGS.head(params.objectKey),
          );
          if (recording === null || recording.etag !== params.etag) {
            return await rejectStep(
              logStageFailure(
                params,
                "verify_recording",
                "source_recording_invalid",
                "validation_error",
                0,
              ),
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
            const recording = await observeStage(
              params,
              "read_recording",
              "recording_read_failed",
              "r2_error",
              () => this.env.RECORDINGS.get(params.objectKey),
            );
            if (recording === null) {
              return await rejectStep(
                logStageFailure(
                  params,
                  "read_recording",
                  "source_recording_invalid",
                  "validation_error",
                  0,
                ),
              );
            }
            const raw = await observeStage(
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
            if (!raw.isOk()) {
              return await rejectStep(
                logStageFailure(params, "inference", "inference_failed", "provider_error", 0),
              );
            }
            const parsed = openAiTranscriptionResponseSchema.safeParse(raw.value);
            if (!parsed.success) {
              return await rejectStep(
                logStageFailure(
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
            if (!keys.isOk()) return await rejectStep(keys.error);
            const jsonKey = keys.value.json;
            const source = { objectKey: params.objectKey, etag: params.etag };
            const metadata = { sourceEtag: params.etag, model: TRANSCRIPTION_MODEL };
            await observeStage(
              params,
              "canonical_write",
              "canonical_write_failed",
              "r2_error",
              () =>
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
            const keys = transcriptArtifactKeys(params.objectKey);
            if (!keys.isOk()) return await rejectStep(keys.error);
            const vttKey = keys.value.vtt;
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
            const keys = transcriptArtifactKeys(params.objectKey);
            if (!keys.isOk()) return await rejectStep(keys.error);
            const textKey = keys.value.text;
            await observeStage(
              params,
              "plaintext_write",
              "plaintext_write_failed",
              "r2_error",
              () =>
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
    return await rejectStep(new Error(`Transcription workflow failed (${failure.errorCode}).`));
  }
}

async function readCanonicalTranscript(bucket: R2Bucket, key: string) {
  const object = await bucket.get(key);
  if (object === null) return await rejectStep(new Error("The canonical transcript is missing."));
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
    return await rejectStep(
      logStageFailure(params, stage, errorCode, category, Date.now() - startedAt),
    );
  }
  return result.value;
}

function rejectStep(cause: unknown): Promise<never> {
  return Promise.reject(cause);
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
