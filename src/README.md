# Source boundaries

- `domain/` contains provider-neutral state transitions and deadline policy.
- `durable-object/` persists each conversation aggregate and hosts its control WebSocket.
- `worker/http/` owns authenticated HTTP routing and browser security policy.
- `worker/realtime/` creates OpenAI Realtime WebRTC calls with server-side credentials.
- `worker/recordings/` coordinates R2 multipart uploads for mixed browser audio.

The React app consumes only `@ai-oral-exam/conversation-client`. The domain does not import
Cloudflare, OpenAI, HTTP, storage, media, or protocol code.
