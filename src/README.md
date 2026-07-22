# Cloudflare control-plane source

Everything under `src/` is bundled into one Cloudflare deployment, but the folders represent
different architectural layers and runtime responsibilities:

```text
src/
├── domain/                  Pure provider-neutral state and deadline rules
├── durable-object/          Stateful ConversationSession runtime
├── shared/                  Internal cross-runtime messages
└── worker/
    ├── index.ts             Wrangler entrypoint and Durable Object export
    ├── http/                Stateless request routing, auth, CORS, and DTOs
    └── integrations/livekit LiveKit SDK boundary and webhook translation
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

The domain must not import Cloudflare, LiveKit, OpenAI, HTTP, storage, or protocol code. LiveKit SDK
types must remain in `worker/integrations/livekit/`. The Durable Object may depend on domain and
the public contract, but must not provision rooms, call OpenAI, or handle audio. The application
must not import `src/` or the contract package directly; it consumes the foundation through the
conversation client.

The LiveKit Agent is intentionally absent from this tree. It is a separate Node.js application in
[`../agent/`](../agent/README.md) and a separate deployment.
