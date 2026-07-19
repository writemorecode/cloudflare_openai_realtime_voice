# Repository guidance

## Canonical architecture

Read `docs/livekit-architecture.md` before changing conversation orchestration, media, recording,
provider integration, state transitions, or deployment boundaries. It is the canonical target
architecture for this experiment.

The target design is LiveKit-first:

- LiveKit is the only browser-facing media plane. The browser joins one LiveKit room over WebRTC.
- A separately deployed LiveKit Agent joins the room and connects to OpenAI's Realtime API through
  LiveKit's maintained OpenAI plugin.
- Cloudflare Workers and the conversation Durable Object are the control plane and must not proxy,
  decode, resample, or persist live audio.
- LiveKit audio-only egress uploads recordings directly to R2 through its S3-compatible endpoint.
  The Worker verifies the R2 object before marking the artifact ready.
- Do not add a simultaneous direct browser-to-OpenAI WebRTC connection to this architecture.

## Durable Object and state-machine rules

- `ConversationSession` is the authoritative aggregate for lifecycle, transport, and artifact state.
- Preserve the shared revision, event receipts, transactional snapshot writes, telemetry, and single
  earliest-deadline alarm.
- Keep the core reducer provider-neutral. LiveKit SDK payloads, identifiers, and error details must
  be translated at the integration boundary.
- Keep public DTOs sanitized. Recording IDs, egress IDs, R2 keys, etags, and provider credentials
  remain internal.
- Treat transport readiness as composite evidence that the browser participant, agent participant,
  agent media, and OpenAI Realtime session are usable. A browser room join alone is insufficient.
- `SessionStarted` continues to require connected transport and active recording.
- Recoverable media interruption keeps lifecycle `live`, uses the existing 20-second deadline, and
  increments the transport epoch on recovery.
- Successful completion requires terminal transport and a verified ready artifact. Cancellation and
  failed outcomes do not require artifact readiness.
- Use stable LiveKit webhook IDs or retry-stable agent IDs as conversation event IDs.

## Integration boundaries

- Keep `POST /v1/conversations/:id/start` provider-neutral.
- Put LiveKit room creation, explicit agent dispatch, egress configuration, and token minting behind
  a separate authenticated access endpoint and `src/livekit/` adapter.
- Verify LiveKit webhook signatures from the raw request body before applying events.
- Run the LiveKit Agent as a separate application under `agent/` or an equivalently clear package;
  do not try to run the persistent agent server inside a Worker request.
- Keep `OPENAI_API_KEY`, `LIVEKIT_API_SECRET`, and R2 S3 credentials in their server-side runtimes.
  Browser access uses short-lived, room-scoped LiveKit tokens.
- Verify the expected R2 object through the Worker binding before emitting
  `RecordingArtifactVerified`.

## Working conventions

- Use `pnpm` for package and script commands.
- Use `apply_patch` for hand-authored file changes.
- Preserve unrelated user changes in a dirty worktree.
- Update `docs/livekit-architecture.md` and relevant tests whenever an architectural invariant or
  state transition changes.
- Regenerate Worker types after changing `wrangler.jsonc` with `pnpm types`.
- Before committing implementation changes, run `pnpm fmt`, `pnpm lint`, `pnpm check`, and an
  explicit source-config dry run with `pnpm exec wrangler deploy --dry-run --config wrangler.jsonc`.
