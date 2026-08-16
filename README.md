# OpenAI Realtime oral examination app

This application runs structured oral examinations with a React browser client and a Cloudflare
Worker. The browser connects directly to the OpenAI Realtime API over WebRTC. The Worker keeps the
standard `OPENAI_API_KEY` server-side and exchanges the browser SDP through
`POST /v1/conversations/:id/realtime-call`.

The Realtime session exposes two function tools:

- `get_current_examination_question`
- `complete_current_examination_question`

The browser executes model tool calls through authenticated Worker routes and sends each result
back as a Realtime `function_call_output` conversation item.

## Recording flow

The browser uses the Web Audio API to mix the microphone and remote model audio into one stream,
records that stream with `MediaRecorder`, and uploads the final artifact using R2 multipart upload:

1. Create an R2 multipart upload when the WebRTC session becomes ready.
2. Record the mixed stream while the examination is live.
3. Split the final blob into uniform 10 MiB parts.
4. Upload each part through the Worker and complete the multipart upload.
5. Mark the recording artifact ready.

R2 credentials are never sent to the browser; the Worker uses the `RECORDINGS` binding.

## Transcription flow

A verified recording for a completed examination creates an idempotent Cloudflare Workflow job.
The Workflow signs a private R2 S3 `GET` URL for 15 minutes and calls
`assemblyai/universal-3-pro` through the configured AI Gateway with two-speaker diarization. AI
Gateway request logging is temporarily enabled for debugging, while caching remains disabled.
Successful jobs write these
artifacts beside the recording:

- `transcript.v1.json` — canonical speaker-labelled utterances and word timestamps.
- `transcript.v1.vtt` — timestamped WebVTT captions with speaker labels.
- `transcript.v1.txt` — readable speaker-labelled plain text.

The bucket must remain private. Presigning uses separate object-read-only R2 S3 credentials in
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`; application logs must never include the credentials
or signed URL. While temporary AI Gateway request logging is enabled, Gateway payload logs may
contain the signed URL and must be treated as sensitive; disable it again after debugging.
Workflow dispatch is backed by the `transcription_jobs` D1 outbox. A five-minute Cron Trigger
retries queued jobs through the idempotent Workflows batch-creation API.

## Local development

Store local secrets in `.dev.vars`:

```dotenv
OPENAI_API_KEY=...
CONVERSATION_ID_SECRET=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
ALLOWED_ORIGIN=http://localhost:5173/
```

Then run:

```sh
pnpm install
pnpm exec wrangler d1 migrations apply EXAM_DB --local
pnpm exec wrangler dev
pnpm dev
```

Vite proxies `/v1` and WebSocket upgrades to Wrangler on port 8787.

## Main routes

- `POST /v1/conversations/:id/realtime-call` — exchange an SDP offer for the OpenAI SDP answer.
- `POST /v1/conversations/:id/tools/:toolName` — execute an authenticated Realtime function call.
- `POST /v1/conversations/:id/recording` — create the multipart recording upload.
- `POST /v1/conversations/:id/recording/upload` — close media and begin artifact upload.
- `PUT /v1/conversations/:id/recording/parts/:partNumber` — upload a part.
- `POST /v1/conversations/:id/recording/complete` — complete and verify the artifact.
- `DELETE /v1/conversations/:id/recording` — abort an incomplete upload.

## Verification

```sh
pnpm check
pnpm build
```
