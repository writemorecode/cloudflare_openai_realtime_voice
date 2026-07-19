# Cloudflare control-plane source

Everything under `src/` is bundled into one Cloudflare deployment, but the folders represent
different architectural layers and runtime responsibilities:

```text
src/
├── domain/                  Pure provider-neutral state and deadline rules
├── durable-object/          Stateful ConversationSession runtime
├── shared/protocol/         Sanitized MessagePack wire contract
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
Durable Object ─────> Shared protocol
```

The domain must not import Cloudflare, LiveKit, OpenAI, HTTP, storage, or protocol code. LiveKit SDK
types must remain in `worker/integrations/livekit/`. The Durable Object may depend on domain and
shared protocol modules, but must not provision rooms, call OpenAI, or handle audio.

The LiveKit Agent is intentionally absent from this tree. It is a separate Node.js application in
[`../agent/`](../agent/README.md) and a separate deployment.
