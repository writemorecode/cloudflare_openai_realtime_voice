# Conversation Durable Object

`ConversationSession` is the authoritative, stateful aggregate for one conversation. It owns:

- transactional snapshots and idempotency receipts;
- revision-checked event application and transition telemetry;
- the single earliest-deadline alarm;
- the transactional time-limit shutdown outbox handed to Cloudflare Queues after commit;
- control WebSocket state and sanitized snapshot broadcasts.

It does not create LiveKit rooms, verify provider webhooks, call OpenAI, process media, or expose
recording keys and provider credentials. Those concerns belong to the stateless Worker integration
boundary or the separate LiveKit Agent.
