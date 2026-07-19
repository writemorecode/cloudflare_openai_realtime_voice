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
  value,
  type ConversationSessionId,
  type ConversationState,
  type UnixMillis,
} from "../domain/conversation-state-machine";
import { ConversationAggregateStore } from "./conversation-aggregate-store";
import { emitAlarmTelemetry, emitTransitionTelemetry } from "./conversation-telemetry";
import type {
  AlarmExecution,
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
} from "./conversation-session-contract";
import { LIVEKIT_SHUTDOWN_OUTBOX_KEY } from "./conversation-session-storage";
import { LiveKitCoordinationStore } from "./livekit-coordination-store";
import { ConversationSocketGateway } from "./conversation-socket-gateway";
import type { LiveKitShutdownMessage } from "../shared/livekit-shutdown";

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
} from "./conversation-session-contract";
export type { AlarmTelemetryRecord, TransitionTelemetryRecord } from "./conversation-telemetry";
export { UnsupportedSnapshotVersionError } from "./conversation-session-storage";

/** One named Durable Object instance owns one conversation aggregate. */
export class ConversationSession extends DurableObject<Env> {
  private readonly aggregate = new ConversationAggregateStore(this.ctx.storage);
  private readonly liveKit = new LiveKitCoordinationStore(this.ctx.storage);
  private readonly sockets = new ConversationSocketGateway(this.ctx, {
    getState: () => this.getState(),
    applyEvent: (command) => this.applyEvent(command),
  });

  override async fetch(request: Request): Promise<Response> {
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

  async initialize(sessionId: ConversationSessionId, at: UnixMillis): Promise<InitializeResult> {
    return this.aggregate.initialize(this.ctx.id.name, sessionId, at);
  }

  getState(): ConversationState | null {
    return this.aggregate.getState();
  }

  beginLiveKitProvisioning(
    command: BeginLiveKitProvisioningCommand,
  ): Promise<BeginLiveKitProvisioningResult> {
    return this.liveKit.beginProvisioning(command);
  }

  async completeLiveKitProvisioning(command: CompleteLiveKitProvisioningCommand): Promise<boolean> {
    return this.liveKit.completeProvisioning(command);
  }

  async abandonLiveKitProvisioning(leaseId: string): Promise<void> {
    await this.liveKit.abandonProvisioning(leaseId);
  }

  async getLiveKitProvisioning(): Promise<LiveKitProvisioningReady | null> {
    return this.liveKit.getProvisioning();
  }

  beginLiveKitShutdown(command: BeginLiveKitShutdownCommand): Promise<BeginLiveKitShutdownResult> {
    return this.liveKit.beginShutdown(command);
  }

  completeLiveKitShutdown(command: CompleteLiveKitShutdownCommand): Promise<boolean> {
    return this.liveKit.completeShutdown(command);
  }

  async abandonLiveKitShutdown(leaseId: string): Promise<void> {
    await this.liveKit.abandonShutdown(leaseId);
  }

  recordAgentObservation(
    command: RecordAgentObservationCommand,
  ): Promise<"recorded" | "duplicate" | "rejected"> {
    return this.liveKit.recordAgentObservation(command);
  }

  async getLiveKitTransportEvidence(): Promise<LiveKitTransportEvidence | null> {
    return this.liveKit.getTransportEvidence();
  }

  recordLiveKitMediaObservation(
    command: RecordLiveKitMediaObservationCommand,
  ): Promise<"recorded" | "duplicate" | "rejected"> {
    return this.liveKit.recordMediaObservation(command);
  }

  async applyEvent(command: ApplyEventCommand): Promise<ApplyEventResult> {
    const result = await this.aggregate.applyEvent(command);
    emitTransitionTelemetry(command, result, "rpc", this.ctx.id.name ?? null);
    if (
      result.outcome !== "rejected" &&
      command.event.type === ConversationEventType.TimeLimitReached
    ) {
      await this.flushLiveKitShutdownOutbox();
    }
    return result;
  }

  /** Applies a trusted server-side integration event and publishes the new snapshot to clients. */
  async applyIntegrationEvent(command: ApplyEventCommand): Promise<ApplyEventResult> {
    const result = await this.applyEvent(command);
    if (result.outcome === "applied") {
      this.sockets.broadcastStateSnapshot(result.state);
    }
    return result;
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const now = value.unixMillis(Date.now());
    let context: Pick<AlarmExecution, "state" | "deadline" | "event"> = {
      state: null,
      deadline: null,
      event: null,
    };
    try {
      await this.flushLiveKitShutdownOutbox();
      const execution = await this.aggregate.applyDeadline(now, (observed) => {
        context = observed;
      });
      if (execution.transition !== null && execution.event !== null) {
        emitTransitionTelemetry(
          { expectedRevision: execution.transition.receipt.sourceRevision, event: execution.event },
          execution.transition,
          "alarm",
          this.ctx.id.name ?? null,
        );
      }
      await this.flushLiveKitShutdownOutbox();
      emitAlarmTelemetry(execution, alarmInfo, now, null, this.ctx.id.name ?? null);
    } catch (error) {
      emitAlarmTelemetry(
        { outcome: "failed", ...context, transition: null },
        alarmInfo,
        now,
        error,
        this.ctx.id.name ?? null,
      );
      throw error;
    }
  }

  private async flushLiveKitShutdownOutbox(): Promise<void> {
    const pending = await this.ctx.storage.get<LiveKitShutdownMessage>(LIVEKIT_SHUTDOWN_OUTBOX_KEY);
    if (pending === undefined) return;

    await this.env.LIVEKIT_SHUTDOWN_QUEUE.send(pending, { contentType: "json" });
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<LiveKitShutdownMessage>(LIVEKIT_SHUTDOWN_OUTBOX_KEY);
      if (current?.triggerEventId === pending.triggerEventId) {
        await transaction.delete(LIVEKIT_SHUTDOWN_OUTBOX_KEY);
      }
    });
  }
}
