# Conversation browser client

This foundation package hides HTTP, control-WebSocket, and LiveKit browser orchestration behind the
`ConversationApi` and `ConversationRuntime` interfaces. It validates public HTTP and WebSocket data
before delivering it to the application.

The application under `web/` depends on this package and must not import the public contract or
control-plane source directly.
