# OpenAI Realtime + Cloudflare RealtimeKit

This repository currently contains only the type-safe conversation lifecycle
state machine and an empty Durable Object shell. It intentionally contains no
RealtimeKit, OpenAI, persistence, networking, or side-effect implementation.

## State machine

```mermaid
stateDiagram-v2
    [*] --> Created
    Created --> Provisioning: StartRequested
    Created --> Cancelled: EndRequested
    Provisioning --> AwaitingBridge: ResourcesProvisioned
    Provisioning --> Failed: ProvisioningAttemptsExhausted
    AwaitingBridge --> StartingRecording: BridgeReady
    StartingRecording --> Live: RecordingConfirmed
    StartingRecording --> Stopping: RecordingFailed or timeout
    Live --> Recovering: RecoverableConnectionLost
    Recovering --> Live: ConnectionsRestored
    Recovering --> Stopping: Recovery deadline or recording failure
    Live --> Stopping: End, time limit, fatal error, or recording failure
    Stopping --> AwaitingRecordingArtifact: RecordingUploadStarted
    Stopping --> Cancelled: ShutdownCompleted without recording
    Stopping --> Failed: Invalid recording or shutdown failure
    AwaitingRecordingArtifact --> PostProcessing: RecordingArtifactVerified
    AwaitingRecordingArtifact --> Failed: Recording or artifact failure
    PostProcessing --> Completed: WorkflowCompleted
    PostProcessing --> ActionRequired: WorkflowAttemptsExhausted
    ActionRequired --> PostProcessing: RetryApproved
    ActionRequired --> Failed: AbandonRequested
    Cancelled --> [*]
    Failed --> [*]
    Completed --> [*]
```

## Type-safety model

TypeScript enums cannot contain associated data. `ConversationStateTag` is
therefore paired with a discriminated union whose member payloads are specific
to each state.

`transition(state, event)` only accepts events legal for the exact compile-time
state variant and returns the exact target-state type. Runtime guards remain for
facts that cannot be proven statically, including bridge readiness, bridge
generation freshness, recording ID equality, and R2 object-key equality.

## Commands

```sh
pnpm check
pnpm types
```
