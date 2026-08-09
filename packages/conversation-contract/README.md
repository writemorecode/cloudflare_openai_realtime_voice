# Conversation public contract

This package is the stable, provider-neutral boundary shared by the control plane and browser
client. It owns runtime schemas and types for sanitized HTTP responses and the versioned
`conversation.v1` MessagePack protocol.

It must not import the internal conversation domain, Cloudflare, React, or application
code. Internal state is explicitly projected into this contract at the Worker boundary. Wire
encoding and decoding return `Result` values rather than throwing protocol errors.
