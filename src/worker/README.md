# Cloudflare Worker

This directory is the stateless HTTP side of the Cloudflare deployment.

- `index.ts` is the Wrangler entrypoint and exports the Durable Object class required by its binding.
- `ports/` defines the external effects used by the conversation foundation: time, identifiers,
  Durable Object lookup, recording lookup, webhook verification, and LiveKit control.
- `adapters/` implements those ports with Cloudflare bindings, Web Crypto, and the LiveKit SDK.
- `foundation-dependencies.ts` is the production dependency composition used by `index.ts`.
- `http/` owns routing, request authentication, CORS, public DTO projection, and API errors.
- `integrations/livekit/` owns LiveKit signature verification, provider payload validation,
  provider-to-domain translation, bounded Queue-driven teardown, and R2 recording verification.

The Worker coordinates trusted control-plane operations. It must never proxy, decode, resample, or
persist live audio. Provider-neutral start behavior stays in the conversation API; future room,
dispatch, egress, and token operations belong behind a separate authenticated LiveKit access route.

Foundation code receives its effects explicitly through the smallest applicable port set. Tests can
therefore supply fixed clocks and identifiers, in-memory provider fakes, and controlled storage
responses without patching globals or constructing SDK resources. `index.ts` is the only production
composition root; integration handlers must not create provider or platform clients themselves.
