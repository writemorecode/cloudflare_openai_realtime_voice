# Worker boundary

The Worker authenticates browser requests, exchanges WebRTC SDP with OpenAI, executes Realtime
function tools, and exposes R2 multipart operations through the `RECORDINGS` binding. Provider
credentials never cross the Worker boundary.

`ports/` describes external effects, `adapters/` implements Cloudflare bindings, and `http/`
assembles the public API. Large audio bodies are streamed directly into R2 upload parts.
