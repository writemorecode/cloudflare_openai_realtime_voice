/** Durable post-recording transcription through AI Gateway and AssemblyAI. */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { presignRecordingGet } from "./presigned-recording-url";
import {
  assemblyAiResponseSchema,
  canonicalTranscript,
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

export class TranscriptionWorkflow extends WorkflowEntrypoint<Env, TranscriptionWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<TranscriptionWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<StoredTranscriptResult> {
    const params = event.payload;
    try {
      await step.do("verify recording and start job", async () => {
        const recording = await this.env.RECORDINGS.head(params.objectKey);
        if (recording === null || recording.etag !== params.etag) {
          throw new Error("The immutable source recording is missing or has changed.");
        }
        await this.env.EXAM_DB.prepare(
          `UPDATE transcription_jobs
           SET status = 'running', started_at = COALESCE(started_at, ?), error_code = NULL
           WHERE id = ? AND source_object_key = ? AND source_etag = ?`,
        )
          .bind(Date.now(), params.jobId, params.objectKey, params.etag)
          .run();
        return { size: recording.size };
      });

      const transcription = await step.do(
        "transcribe recording",
        {
          retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
          timeout: "20 minutes",
          sensitive: "output",
        },
        async () => {
          const audioUrl = await presignRecordingGet(
            {
              accountId: this.env.R2_ACCOUNT_ID,
              bucketName: this.env.R2_BUCKET_NAME,
              accessKeyId: this.env.R2_ACCESS_KEY_ID,
              secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
            },
            params.objectKey,
          );
          const raw = await this.env.AI.run(
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
                collectLog: false,
              },
            },
          );
          return {
            generatedAt: Date.now(),
            response: assemblyAiResponseSchema.parse(raw),
          };
        },
      );

      const stored = await step.do("store transcript artifacts", async () => {
        const keys = transcriptArtifactKeys(params.objectKey);
        const source = { objectKey: params.objectKey, etag: params.etag };
        const metadata = { sourceEtag: params.etag, model: TRANSCRIPTION_MODEL };
        await Promise.all([
          this.env.RECORDINGS.put(
            keys.json,
            `${JSON.stringify(
              canonicalTranscript(source, transcription.response, transcription.generatedAt),
              null,
              2,
            )}\n`,
            {
              httpMetadata: { contentType: "application/json; charset=utf-8" },
              customMetadata: metadata,
            },
          ),
          this.env.RECORDINGS.put(keys.vtt, webVtt(transcription.response), {
            httpMetadata: { contentType: "text/vtt; charset=utf-8" },
            customMetadata: metadata,
          }),
          this.env.RECORDINGS.put(keys.text, plainTextTranscript(transcription.response), {
            httpMetadata: { contentType: "text/plain; charset=utf-8" },
            customMetadata: metadata,
          }),
        ]);
        return { jsonKey: keys.json, vttKey: keys.vtt, textKey: keys.text };
      });

      await step.do("complete transcription job", async () => {
        await this.env.EXAM_DB.prepare(
          `UPDATE transcription_jobs
           SET status = 'complete', transcript_json_key = ?, transcript_vtt_key = ?,
               transcript_text_key = ?, completed_at = ?, error_code = NULL
           WHERE id = ?`,
        )
          .bind(stored.jsonKey, stored.vttKey, stored.textKey, Date.now(), params.jobId)
          .run();
        return { completed: true };
      });

      return stored;
    } catch (cause) {
      const errorCode = transcriptionErrorCode(cause);
      await step.do("record transcription failure", async () => {
        await this.env.EXAM_DB.prepare(
          `UPDATE transcription_jobs
           SET status = 'failed', error_code = ?, completed_at = ?
           WHERE id = ?`,
        )
          .bind(errorCode, Date.now(), params.jobId)
          .run();
        return { failed: true };
      });
      console.error({
        kind: "transcription_workflow_error",
        jobId: params.jobId,
        conversationId: params.conversationId,
        errorCode,
      });
      // Do not preserve provider errors because they can contain the presigned URL.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Transcription workflow failed (${errorCode}).`);
    }
  }
}

function transcriptionErrorCode(cause: unknown): string {
  if (cause instanceof Error && cause.message.includes("source recording")) {
    return "source_recording_invalid";
  }
  return "transcription_failed";
}
