# LiveKit Agent application

This workspace is a separately deployed Node.js process, not part of the Cloudflare Worker bundle.
It joins a LiveKit room as `oral-exam-agent`, opens the OpenAI Realtime session through LiveKit's
maintained plugin, and publishes model audio back to the room.

```text
agent/src/
├── main.ts                 LiveKit process entrypoint and job wiring
├── config.ts               Agent-runtime environment validation
├── dispatch-metadata.ts    Versioned Worker-to-agent job contract
├── assistant.ts            Voice assistant instructions
├── examination-client.ts   Authenticated fixed-question tool client
├── model.ts                OpenAI Realtime plugin construction
├── runtime.ts              Testable per-job orchestration
└── reporter.ts             Control-plane lifecycle reporting contract
```

The agent may know LiveKit and OpenAI, but it must not import Worker or Durable Object source. It
does not own durable conversation state, question progress, or R2 verification. The canonical
`examiner_agent_system_prompt.md` is packaged with the agent. Production jobs call
`get_current_examination_question`, then run the per-question `AgentTask`s in one shared-context
`TaskGroup`; each task calls `complete_current_examination_question` after any justified follow-up.
Secrets in this runtime are limited to LiveKit project credentials supplied by the platform,
`OPENAI_API_KEY`, and the agent-only `AGENT_CALLBACK_TOKEN`. Dispatched jobs also require the
non-secret `AGENT_CONTROL_PLANE_URL`; synthetic console jobs explicitly use the no-op reporter.

Run its checks from the repository root:

```sh
pnpm --filter @ai-oral-exam/livekit-agent check
```
