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

The exported Durable Object class is a runtime and RPC facade. Its internal capabilities are split
by responsibility while sharing the same object storage and consistency boundary:

- `ConversationAggregateStore` owns snapshots, transition receipts, revision checks, deadline
  selection, and the transactional shutdown-outbox write.
- `LiveKitCoordinationStore` owns provisioning and shutdown leases plus retry-stable transport
  evidence receipts. Matching evidence can be recorded against either an active provisioning lease
  or completed provisioning metadata, so provider callbacks cannot outrun resource setup. It
  returns explicit rejection reasons through the internal RPC boundary.
- `ConversationSocketGateway` owns the hibernatable control-WebSocket protocol and snapshot
  broadcasts.
- `ConversationAlarmRunner` applies the single earliest deadline and delivers the shutdown outbox
  after the aggregate transaction commits.

Expected lifecycle and concurrency rejections use discriminated result types. Corrupt persisted
state and storage, queue, encoding, or runtime failures throw. Callers must therefore handle both
the documented result union and infrastructure exceptions from RPC.
