/**
 * Cloudflare Durable Object runtime for one conversation aggregate.
 *
 * This is the authoritative stateful boundary: it persists snapshots and receipts, serializes
 * transitions, owns the single alarm, and hosts the control WebSocket. It does not call media or
 * model providers and it never handles audio bytes.
 */
import { DurableObject } from "cloudflare:workers";
import { serializeResult, type ResultWire } from "@ai-oral-exam/conversation-contract";

import {
  type ConversationSessionId,
  type ConversationState,
  type UnixMillis,
} from "../domain/conversation-state-machine";
import {
  ConversationAggregateStore,
  type AggregateStoreResult,
  type AggregateStoreError,
} from "./conversation-aggregate-store";
import { ConversationAlarmRunner } from "./conversation-alarm-runner";
import { emitTransitionTelemetry } from "./conversation-telemetry";
import type {
  ApplyEventCommand,
  ApplyEventResult,
  InitializeResult,
} from "./conversation-session-contract";
import { ConversationSocketGateway } from "./conversation-socket-gateway";

export type {
  ApplyEventCommand,
  ApplyEventResult,
  InitializeResult,
} from "./conversation-session-contract";
export type { AlarmTelemetryRecord, TransitionTelemetryRecord } from "./conversation-telemetry";
export type { UnsupportedSnapshotVersionError } from "./conversation-session-storage";

/** One named Durable Object instance owns one conversation aggregate. */
export class ConversationSession extends DurableObject<Env> {
  private readonly aggregate = new ConversationAggregateStore(this.ctx.storage);
  private readonly alarms = new ConversationAlarmRunner(
    this.ctx.storage,
    this.aggregate,
    this.ctx.id.name ?? null,
  );
  private readonly sockets = new ConversationSocketGateway(this.ctx, {
    getState: () => this.getStateInternal(),
    applyEvent: (command) => this.applyEventInternal(command),
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

  override async webSocketError<Failure>(_ws: WebSocket, error: Failure): Promise<void> {
    this.sockets.handleError(error);
  }

  /** Initializes this named object once; rejects identity mismatches without mutating storage. */
  async initialize(
    sessionId: ConversationSessionId,
    at: UnixMillis,
  ): Promise<ResultWire<InitializeResult, AggregateStoreError>> {
    return serializeResult(await this.initializeInternal(sessionId, at));
  }

  /** Returns the authoritative snapshot, or null before initialization. */
  getState(): ResultWire<ConversationState | null, AggregateStoreError> {
    return serializeResult(this.getStateInternal());
  }

  /** Applies one revision-checked domain event. */
  async applyEvent(
    command: ApplyEventCommand,
  ): Promise<ResultWire<ApplyEventResult, AggregateStoreError>> {
    return serializeResult(await this.applyEventInternal(command));
  }

  private initializeInternal(
    sessionId: ConversationSessionId,
    at: UnixMillis,
  ): Promise<AggregateStoreResult<InitializeResult>> {
    return this.aggregate.initialize(this.ctx.id.name, sessionId, at);
  }

  private getStateInternal(): AggregateStoreResult<ConversationState | null> {
    return this.aggregate.getState();
  }

  private async applyEventInternal(
    command: ApplyEventCommand,
  ): Promise<AggregateStoreResult<ApplyEventResult>> {
    const stored = await this.aggregate.applyEvent(command);
    if (!stored.isOk()) return stored;
    const result = stored.value;
    emitTransitionTelemetry(command, result, "rpc", this.ctx.id.name ?? null);
    return stored;
  }

  /** Applies a trusted server-side integration event and publishes the new snapshot to clients. */
  async applyIntegrationEvent(
    command: ApplyEventCommand,
  ): Promise<ResultWire<ApplyEventResult, AggregateStoreError>> {
    const stored = await this.applyEventInternal(command);
    if (!stored.isOk()) return serializeResult(stored);
    const result = stored.value;
    if (result.outcome === "applied") {
      this.sockets.broadcastStateSnapshot(result.state);
    }
    return serializeResult(stored);
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const completed = await this.alarms.run(alarmInfo);
    if (!completed.isOk()) return;
    const state = this.getStateInternal();
    if (state.isOk() && state.value !== null) this.sockets.broadcastStateSnapshot(state.value);
  }
}
