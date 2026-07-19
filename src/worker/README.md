# Cloudflare Worker

This directory is the stateless HTTP side of the Cloudflare deployment.

- `index.ts` is the Wrangler entrypoint and exports the Durable Object class required by its binding.
- `http/` owns routing, request authentication, CORS, public DTO projection, and API errors.
- `integrations/livekit/` owns LiveKit signature verification, provider payload validation,
  provider-to-domain translation, bounded Queue-driven teardown, and R2 recording verification.

The Worker coordinates trusted control-plane operations. It must never proxy, decode, resample, or
persist live audio. Provider-neutral start behavior stays in the conversation API; future room,
dispatch, egress, and token operations belong behind a separate authenticated LiveKit access route.
