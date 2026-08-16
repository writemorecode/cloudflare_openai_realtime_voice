import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { Result } from "better-result";

import { executeD1, firstStatementRows, quoteSql } from "./auth-user-utils.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseTranscriptionTriggerArguments(argv) {
  const args = [...argv];
  while (args[0] === "--") args.shift();
  const location = args.shift();
  const conversationId = args.shift();
  if (
    (location !== "--local" && location !== "--remote") ||
    conversationId === undefined ||
    !UUID_PATTERN.test(conversationId) ||
    args.length > 0
  ) {
    return Result.err(new Error("invalid transcription trigger arguments"));
  }
  return Result.ok({ location, conversationId });
}

const RECORDING_EXTENSIONS = ["webm", "ogg", "mp4"];

export async function findRecording({
  accountId,
  bucketName,
  accessKeyId,
  secretAccessKey,
  conversationId,
  client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" }),
}) {
  const probes = await Promise.all(
    RECORDING_EXTENSIONS.map(async (extension) => {
      const objectKey = `conversations/${conversationId}/recording.${extension}`;
      const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
      const url = `https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucketName)}/${encodedKey}`;
      const response = await Result.tryPromise({
        try: () => client.fetch(url, { method: "HEAD" }),
        catch: (error) => error,
      });
      if (!response.isOk()) return response;
      if (response.value.status === 404) return Result.ok(null);
      if (!response.value.ok) {
        return Result.err(
          new Error(`R2 object inspection failed with HTTP ${response.value.status}.`),
        );
      }
      const etag = normalizeEtag(response.value.headers.get("etag"));
      return etag === null
        ? Result.err(new Error(`R2 returned no ETag for ${objectKey}.`))
        : Result.ok({ objectKey, etag });
    }),
  );
  const failure = probes.find((probe) => !probe.isOk());
  if (failure !== undefined && !failure.isOk()) return failure;
  const matches = probes.flatMap((probe) =>
    probe.isOk() && probe.value !== null ? [probe.value] : [],
  );
  if (matches.length === 0) {
    return Result.err(new Error(`No recording object exists for conversation ${conversationId}.`));
  }
  if (matches.length > 1) {
    return Result.err(
      new Error(`Multiple recording objects exist for conversation ${conversationId}.`),
    );
  }
  return Result.ok(matches[0]);
}

export async function createTranscriptionJob({
  database,
  location,
  conversationId,
  recording,
  now = Date.now(),
}) {
  const jobId = transcriptionJobId(conversationId, recording.objectKey, recording.etag);
  const sql = transcriptionJobSql({ jobId, conversationId, recording, now });
  const execution = await executeD1({ database, location, sql, json: true });
  if (!execution.isOk()) return execution;
  const rows = firstStatementRows(execution.value);
  const row = rows?.[0];
  if (row === undefined || typeof row.id !== "string") {
    return Result.err(
      new Error(`No completed examination session exists for conversation ${conversationId}.`),
    );
  }
  return Result.ok({
    jobId: row.id,
    objectKey: recording.objectKey,
    etag: recording.etag,
  });
}

export function transcriptionJobSql({ jobId, conversationId, recording, now }) {
  return `INSERT INTO transcription_jobs (
  id, examination_session_id, source_object_key, source_etag, model, status, created_at
)
SELECT ${quoteSql(jobId)}, sessions.id, ${quoteSql(recording.objectKey)},
       ${quoteSql(recording.etag)}, 'assemblyai/universal-3-pro', 'queued', ${now}
FROM examination_sessions AS sessions
WHERE sessions.conversation_id = ${quoteSql(conversationId)}
  AND sessions.question_state = 'complete'
ON CONFLICT(source_object_key, source_etag) DO UPDATE SET model = transcription_jobs.model
RETURNING id;`;
}

export function workflowTriggerArguments({
  workflow,
  location,
  conversationId,
  job,
  now = Date.now(),
}) {
  const instanceId = `${job.jobId}-manual-${now}`;
  const params = JSON.stringify({
    jobId: job.jobId,
    conversationId,
    objectKey: job.objectKey,
    etag: job.etag,
  });
  return [
    "exec",
    "wrangler",
    "workflows",
    "trigger",
    workflow,
    params,
    "--id",
    instanceId,
    ...(location === "--local" ? ["--local"] : []),
  ];
}

export async function triggerWorkflow(options, spawnProcess = spawn) {
  const child = spawnProcess("pnpm", workflowTriggerArguments(options), {
    stdio: "inherit",
    env: { ...process.env, WRANGLER_LOG_PATH: "/tmp/wrangler-transcription-trigger.log" },
  });
  const exitCode = await Result.tryPromise({
    try: () =>
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      }),
    catch: (error) => error,
  });
  if (!exitCode.isOk()) return exitCode;
  return exitCode.value === 0
    ? Result.ok(undefined)
    : Result.err(new Error(`Wrangler exited with status ${exitCode.value}.`));
}

function transcriptionJobId(conversationId, objectKey, etag) {
  const hash = createHash("sha256").update(`${objectKey}\n${etag}`).digest("hex");
  return `transcription-${conversationId}-${hash.slice(0, 24)}`;
}

function normalizeEtag(value) {
  if (value === null) return null;
  return value.replace(/^W\//, "").replace(/^"|"$/g, "");
}
