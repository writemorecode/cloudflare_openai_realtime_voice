# Conversation domain

This directory contains the provider-neutral conversation aggregate:

- `conversation-state-machine.ts` defines state, events, guards, and the pure reducer.
- `conversation-deadlines.ts` derives the earliest deadline and its deterministic event.

Code belongs here only when it can run without Cloudflare, LiveKit, OpenAI, HTTP, storage, or media
knowledge. Integration-specific errors and identifiers must be normalized before reaching this
layer.
