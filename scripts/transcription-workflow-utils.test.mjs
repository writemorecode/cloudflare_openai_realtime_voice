import assert from "node:assert/strict";
import test from "node:test";

import {
  findRecording,
  parseTranscriptionTriggerArguments,
  transcriptionJobSql,
  workflowTriggerArguments,
} from "./transcription-workflow-utils.mjs";

const conversationId = "123e4567-e89b-42d3-a456-426614174000";
const job = {
  jobId: "transcription-job",
  objectKey: `conversations/${conversationId}/recording.webm`,
  etag: "recording-etag",
};

test("requires an explicit local or remote location", () => {
  assert.equal(parseTranscriptionTriggerArguments([conversationId]).isErr(), true);
  assert.deepEqual(parseTranscriptionTriggerArguments(["--", "--local", conversationId]).value, {
    location: "--local",
    conversationId,
  });
});

test("rejects invalid conversation identifiers and extra arguments", () => {
  assert.equal(parseTranscriptionTriggerArguments(["--remote", "not-a-uuid"]).isErr(), true);
  assert.equal(
    parseTranscriptionTriggerArguments(["--remote", conversationId, "extra"]).isErr(),
    true,
  );
});

test("builds a local workflow trigger with the job payload", () => {
  const args = workflowTriggerArguments({
    workflow: "oral-exam-transcription-dev",
    location: "--local",
    conversationId,
    job,
    now: 1234,
  });
  assert.deepEqual(args.slice(0, 5), [
    "exec",
    "wrangler",
    "workflows",
    "trigger",
    "oral-exam-transcription-dev",
  ]);
  assert.deepEqual(JSON.parse(args[5]), {
    jobId: job.jobId,
    conversationId,
    objectKey: job.objectKey,
    etag: job.etag,
  });
  assert.deepEqual(args.slice(6), ["--id", "transcription-job-manual-1234", "--local"]);
});

test("omits the local flag for a remote workflow trigger", () => {
  const args = workflowTriggerArguments({
    workflow: "oral-exam-transcription-dev",
    location: "--remote",
    conversationId,
    job,
    now: 1234,
  });
  assert.equal(args.includes("--local"), false);
});

test("finds the single supported recording object and normalizes its ETag", async () => {
  const client = {
    fetch: async (url) =>
      url.endsWith("recording.ogg")
        ? new Response(null, { status: 200, headers: { etag: '"recording-etag"' } })
        : new Response(null, { status: 404 }),
  };
  const result = await findRecording({
    accountId: "account",
    bucketName: "bucket",
    accessKeyId: "access",
    secretAccessKey: "secret",
    conversationId,
    client,
  });
  assert.deepEqual(result.value, {
    objectKey: `conversations/${conversationId}/recording.ogg`,
    etag: "recording-etag",
  });
});

test("builds an idempotent job insert for a completed examination session", () => {
  const sql = transcriptionJobSql({
    jobId: "transcription-job",
    conversationId,
    recording: job,
    now: 1234,
  });
  assert.match(sql, /question_state = 'complete'/);
  assert.match(sql, /ON CONFLICT\(source_object_key, source_etag\)/);
  assert.match(sql, /RETURNING id/);
});
