# Cloudflare control-plane source

Everything under `src/` is bundled into one Cloudflare deployment, but the folders represent
different architectural layers and runtime responsibilities:

```text
src/
├── domain/                  Pure provider-neutral state and deadline rules
├── durable-object/          Stateful ConversationSession runtime
├── shared/                  Internal cross-runtime messages
└── worker/
    ├── index.ts             Wrangler entrypoint and production composition root
    ├── ports/               External-effect interfaces for the foundation
    ├── adapters/            Cloudflare, Web Crypto, R2, and LiveKit implementations
    ├── http/                Stateless request routing, auth, CORS, and DTOs
    └── integrations/livekit Pure decisions beside effectful orchestration executors
```

Dependency direction is intentional:

```text
Worker integrations ─┐
Worker HTTP ──────────┼──> Domain
Durable Object ───────┘

Worker HTTP ────────> Durable Object RPC
Worker and DO ──────> Public contract
```

The browser-facing contract and reusable browser transport are separate workspace packages:

```text
packages/conversation-contract/  Versioned, runtime-validated public HTTP/WebSocket contract
packages/conversation-client/    HTTP, control-WebSocket, and LiveKit browser orchestration
web/                             Product UI; imports only conversation-client
```

The domain must not import Cloudflare, LiveKit, OpenAI, HTTP, storage, or protocol code. Provider
SDK construction must remain in `worker/adapters/`; integration handlers depend on the interfaces
in `worker/ports/`. The Durable Object may depend on domain and the public contract, but must not
provision rooms, call OpenAI, or handle audio. The application must not import `src/` or the
contract package directly; it consumes the foundation through the conversation client.

Within the LiveKit integration boundary, `*-decisions.ts` modules are synchronous and effect-free.
They decode provider data or select the next action from supplied state. The neighboring executor
modules obtain state through ports, apply the selected action, and handle retries and telemetry.

The LiveKit Agent is intentionally absent from this tree. It is a separate Node.js application in
[`../agent/`](../agent/README.md) and a separate deployment.
