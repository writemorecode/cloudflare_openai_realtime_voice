/**
 * Cloudflare Durable Object runtime for one conversation aggregate.
 *
 * This is the authoritative stateful boundary: it persists snapshots and receipts, serializes
 * transitions, owns the single alarm, and hosts the control WebSocket. It does not call media or
 * model providers and it never handles audio bytes.
 */
import { DurableObject } from "cloudflare:workers";

import {
  ConversationEventType,
  type ConversationSessionId,
  type ConversationState,
  type UnixMillis,
} from "../domain/conversation-state-machine";
import {
  ConversationAggregateStore,
  type AggregateStoreResult,
} from "./conversation-aggregate-store";
import { ConversationAlarmRunner } from "./conversation-alarm-runner";
import { emitTransitionTelemetry } from "./conversation-telemetry";
import type {
  ApplyEventCommand,
  ApplyEventResult,
  BeginLiveKitProvisioningCommand,
  BeginLiveKitProvisioningResult,
  BeginLiveKitShutdownCommand,
  BeginLiveKitShutdownResult,
  CompleteLiveKitProvisioningCommand,
  CompleteLiveKitShutdownCommand,
  InitializeResult,
  LiveKitProvisioningReady,
  LiveKitTransportEvidence,
  RecordAgentObservationCommand,
  RecordLiveKitMediaObservationCommand,
  RecordObservationRpcResult,
  RecordObservationResult,
} from "./conversation-session-contract";
import { LiveKitCoordinationStore } from "./livekit-coordination-store";
import { ConversationSocketGateway } from "./conversation-socket-gateway";

export type {
  AgentObservationKind,
  ApplyEventCommand,
  ApplyEventResult,
  BeginLiveKitProvisioningResult,
  BeginLiveKitShutdownResult,
  InitializeResult,
  LiveKitMediaObservationKind,
  LiveKitProvisioningReady,
  LiveKitTransportEvidence,
  RecordObservationRpcResult,
} from "./conversation-session-contract";
export type { AlarmTelemetryRecord, TransitionTelemetryRecord } from "./conversation-telemetry";
export type { UnsupportedSnapshotVersionError } from "./conversation-session-storage";

/** One named Durable Object instance owns one conversation aggregate. */
export class ConversationSession extends DurableObject<Env> {
  private readonly aggregate = new ConversationAggregateStore(this.ctx.storage);
  private readonly liveKit = new LiveKitCoordinationStore(this.ctx.storage);
  private readonly alarms = new ConversationAlarmRunner(
    this.ctx.storage,
    this.env.LIVEKIT_SHUTDOWN_QUEUE,
    this.aggregate,
    this.ctx.id.name ?? null,
  );
  private readonly sockets = new ConversationSocketGateway(this.ctx, {
    getState: () => this.getState(),
    applyEvent: (command) => this.applyEvent(command),
  });

  override fetch(request: Request): Promise<Response> {
    return this.sockets.accept(request);
  }

  override async webSocketMessage(ws: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    await this.sockets.handleMessage(ws, rawMessage);
  }

  override async webSocketClose(
    _ws: WebSocket,
    code: number,
    _reason: string,
    wasClean: boolean,
  ): Promise<void> {
    this.sockets.handleClose(code, wasClean);
  }

  override async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    this.sockets.handleError(error);
  }

  /** Initializes this named object once; rejects identity mismatches without mutating storage. */
  async initialize(
    sessionId: ConversationSessionId,
    at: UnixMillis,
  ): Promise<AggregateStoreResult<InitializeResult>> {
    return this.aggregate.initialize(this.ctx.id.name, sessionId, at);
  }

  /** Returns the authoritative snapshot, or null before initialization. */
  getState(): AggregateStoreResult<ConversationState | null> {
    return this.aggregate.getState();
  }

  /** Claims or observes the retry-safe LiveKit provisioning lease for the current starting epoch. */
  beginLiveKitProvisioning(
    command: BeginLiveKitProvisioningCommand,
  ): Promise<BeginLiveKitProvisioningResult> {
    return this.liveKit.beginProvisioning(command);
  }

  /** Commits provider identifiers only when the caller still owns the provisioning lease. */
  completeLiveKitProvisioning(command: CompleteLiveKitProvisioningCommand): Promise<boolean> {
    return this.liveKit.completeProvisioning(command);
  }

  /** Releases a provisioning lease owned by the supplied lease ID. */
  abandonLiveKitProvisioning(leaseId: string): Promise<void> {
    return this.liveKit.abandonProvisioning(leaseId);
  }

  /** Returns completed internal LiveKit provisioning metadata, if available. */
  getLiveKitProvisioning(): Promise<LiveKitProvisioningReady | null> {
    return this.liveKit.getProvisioning();
  }

  /** Claims or observes teardown after the conversation has left its active lifecycle states. */
  beginLiveKitShutdown(command: BeginLiveKitShutdownCommand): Promise<BeginLiveKitShutdownResult> {
    return this.liveKit.beginShutdown(command);
  }

  /** Marks teardown complete only when the caller still owns the shutdown lease. */
  completeLiveKitShutdown(command: CompleteLiveKitShutdownCommand): Promise<boolean> {
    return this.liveKit.completeShutdown(command);
  }

  /** Releases a shutdown lease owned by the supplied lease ID. */
  abandonLiveKitShutdown(leaseId: string): Promise<void> {
    return this.liveKit.abandonShutdown(leaseId);
  }

  /** Records retry-stable agent readiness evidence against provisioning or ready correlation. */
  async recordAgentObservation(
    command: RecordAgentObservationCommand,
  ): Promise<RecordObservationRpcResult> {
    return toObservationRpcResult(await this.liveKit.recordAgentObservation(command));
  }

  /** Returns the current composite transport evidence used by readiness reconciliation. */
  getLiveKitTransportEvidence(): Promise<LiveKitTransportEvidence | null> {
    return this.liveKit.getTransportEvidence();
  }

  /** Records retry-stable media evidence against provisioning or ready correlation. */
  recordLiveKitMediaObservation(
    command: RecordLiveKitMediaObservationCommand,
  ): Promise<RecordObservationRpcResult> {
    return this.liveKit.recordMediaObservation(command).then(toObservationRpcResult);
  }

  /** Applies one revision-checked domain event and flushes a time-limit shutdown outbox entry. */
  async applyEvent(command: ApplyEventCommand): Promise<AggregateStoreResult<ApplyEventResult>> {
    const stored = await this.aggregate.applyEvent(command);
    if (!stored.ok) return stored;
    const result = stored.value;
    emitTransitionTelemetry(command, result, "rpc", this.ctx.id.name ?? null);
    if (
      result.outcome !== "rejected" &&
      command.event.type === ConversationEventType.TimeLimitReached
    ) {
      await this.alarms.flushShutdownOutbox();
    }
    return stored;
  }

  /** Applies a trusted server-side integration event and publishes the new snapshot to clients. */
  async applyIntegrationEvent(
    command: ApplyEventCommand,
  ): Promise<AggregateStoreResult<ApplyEventResult>> {
    const stored = await this.applyEvent(command);
    if (!stored.ok) return stored;
    const result = stored.value;
    if (result.outcome === "applied") {
      this.sockets.broadcastStateSnapshot(result.state);
    }
    return stored;
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.alarms.run(alarmInfo);
  }
}

function toObservationRpcResult(result: RecordObservationResult): RecordObservationRpcResult {
  return {
    outcome: result.outcome,
    reason: result.outcome === "rejected" ? result.reason : null,
  };
}
