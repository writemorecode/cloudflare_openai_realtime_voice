# Deterministic foundation harness

`FoundationHarness` exercises the control-plane foundation as a single unit without requiring
LiveKit or R2. Use it for lifecycle, orchestration, retry, correlation, and public-boundary
scenarios.

The harness keeps these parts real:

- the conversation HTTP router, authentication, CORS, and response mapping;
- LiveKit access, webhook, agent-event, and shutdown orchestration;
- the bound `ConversationSession` Durable Object, its RPC surface, storage, reducer, receipts, and
  revision checks;
- provider-neutral decisions and sanitized public DTOs.

It replaces only external or nondeterministic effects:

- wall-clock and UUID generation;
- LiveKit room, dispatch, egress, teardown, and token operations;
- LiveKit webhook signature verification;
- recording-object lookup.

The in-memory LiveKit port records every operation and can fail the next operation of a selected
kind. The recording and webhook ports provide equivalent one-shot failure controls. This makes
partial-progress and retry behavior explicit without module mocks.

## Writing a scenario

```ts
const harness = new FoundationHarness(env);
const starting = await harness.createStartedConversation("unique-scenario-key");

await harness.provisionConversation(starting.conversationId);
await harness.reachLive(starting.conversationId);

harness.clock.advance(1_000);
await harness.beginEnding(starting.conversationId);
await harness.stopConversationResources(starting.conversationId);
await harness.completeRecording(starting.conversationId);
await harness.closeRoom(starting.conversationId);

expect(await harness.state(starting.conversationId)).toMatchObject({
  tag: "completed",
  data: {
    transport: { status: "closed" },
    artifact: { status: "ready" },
  },
});
```

Prefer the high-level scenario helpers when the setup is incidental to the behavior under test.
Use `webhook`, `agentEvent`, `session`, and the individual fake ports when exact ordering, malformed
input, or a failure seam is the subject.

The injected clock controls request and domain-event timestamps. Miniflare still owns actual Durable
Object alarm delivery, so the default harness epoch is far enough in the future to prevent an alarm
from firing accidentally. Tests specifically about alarm scheduling and delivery should continue to
use the dedicated Durable Object alarm tests.

The fake webhook verifier deliberately bypasses cryptographic signing but still decodes payloads
with LiveKit's SDK. Keep signature, raw-body, and production-adapter coverage in their focused
integration tests.

Run the harness scenarios with:

```sh
pnpm test:foundation
```
