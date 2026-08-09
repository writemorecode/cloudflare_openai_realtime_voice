# Conversation Durable Object

One `ConversationSession` instance owns each conversation snapshot, transition receipts, deadline
alarm, and hibernatable control WebSocket. It does not process audio or call OpenAI. Trusted Worker
services translate Realtime and recording outcomes into provider-neutral domain events.
