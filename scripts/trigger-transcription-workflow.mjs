import { Result } from "better-result";
import { existsSync } from "node:fs";

import {
  createTranscriptionJob,
  findRecording,
  parseTranscriptionTriggerArguments,
  triggerWorkflow,
} from "./transcription-workflow-utils.mjs";

const DATABASE = "EXAM_DB";
const WORKFLOW = "oral-exam-transcription-dev";
const R2_ACCOUNT_ID = "017227baf7a62fd2323cc61950f5d57e";
const R2_BUCKET_NAME = "oral-exam-recordings-dev";
const usage = "Usage: pnpm transcription:trigger -- (--local|--remote) <conversation-id>";

if (existsSync(".dev.vars")) process.loadEnvFile(".dev.vars");

const result = await Result.tryPromise({
  try: async () => {
    const parsed = parseTranscriptionTriggerArguments(process.argv.slice(2));
    if (!parsed.isOk()) return Promise.reject(parsed.error);
    const { location, conversationId } = parsed.value;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (accessKeyId === undefined || secretAccessKey === undefined) {
      return Promise.reject(new Error("R2 S3 credentials are missing from .dev.vars."));
    }
    const recording = await findRecording({
      accountId: R2_ACCOUNT_ID,
      bucketName: R2_BUCKET_NAME,
      accessKeyId,
      secretAccessKey,
      conversationId,
    });
    if (!recording.isOk()) return Promise.reject(recording.error);
    const job = await createTranscriptionJob({
      database: DATABASE,
      location,
      conversationId,
      recording: recording.value,
    });
    if (!job.isOk()) return Promise.reject(job.error);
    const triggered = await triggerWorkflow({
      workflow: WORKFLOW,
      location,
      conversationId,
      job: job.value,
    });
    if (!triggered.isOk()) return Promise.reject(triggered.error);
  },
  catch: (error) => error,
});

if (!result.isOk()) {
  if (
    result.error instanceof Error &&
    result.error.message === "invalid transcription trigger arguments"
  ) {
    console.error(usage);
  } else {
    console.error(
      result.error instanceof Error ? result.error.message : "Could not trigger transcription.",
    );
  }
  process.exitCode = 1;
}
