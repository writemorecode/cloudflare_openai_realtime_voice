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
  createTranscript,
  openAiTranscriptionResponseSchema,
  TRANSCRIPTION_MODEL,
  transcriptArtifactKey,
} from "./transcript-artifacts";

export interface TranscriptionWorkflowParams {
  readonly jobId: string;
  readonly conversationId: string;
  readonly objectKey: string;
  readonly etag: string;
}

interface StoredTranscriptResult {
  readonly transcriptKey: string;
}

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

        const transcript = await step.do(
          "transcribe and store transcript",
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
            const key = transcriptArtifactKey(params.objectKey);
            if (!key.isOk()) return failStep(key.error);
            const transcriptKey = key.value;
            const source = { objectKey: params.objectKey, etag: params.etag };
            const artifact = createTranscript(params.conversationId, source, response, generatedAt);
            await runStage(params, "transcript_write", "transcript_write_failed", "r2_error", () =>
              this.env.RECORDINGS.put(transcriptKey, `${JSON.stringify(artifact, null, 2)}\n`, {
                httpMetadata: { contentType: "application/json; charset=utf-8" },
                customMetadata: {
                  sourceEtag: params.etag,
                  model: TRANSCRIPTION_MODEL,
                  schemaVersion: String(artifact.schemaVersion),
                },
              }),
            );
            return { transcriptKey };
          },
        );

        await step.do("complete transcription job", async () => {
          await runStage(params, "complete_job", "job_completion_failed", "d1_error", () =>
            this.env.EXAM_DB.prepare(
              `UPDATE transcription_jobs
               SET status = 'complete', transcript_key = ?, completed_at = ?, error_code = NULL
               WHERE id = ?`,
            )
              .bind(transcript.transcriptKey, Date.now(), params.jobId)
              .run(),
          );
          return { completed: true };
        });

        return transcript;
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
