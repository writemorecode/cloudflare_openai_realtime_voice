/**
 * Cloudflare Durable Object runtime for one conversation aggregate.
 *
 * This is the authoritative stateful boundary: it persists snapshots and receipts, serializes
 * transitions, owns the single alarm, and hosts the control WebSocket. It does not call media or
 * model providers and it never handles audio bytes.
 */
import { DurableObject } from "cloudflare:workers";

import {
  ALARM_SHUTDOWN_GRACE_MS,
  deadlineEventForState,
  deadlineForState,
} from "../domain/conversation-deadlines";
import {
  ConversationEventType,
  ConversationStateTag,
  IllegalTransitionError,
  TransitionGuardError,
  TransportStatus,
  createConversation,
  transitionRuntime,
  value,
  type ConversationEvent,
  type ConversationSessionId,
  type ConversationState,
  type TransportState,
  type UnixMillis,
} from "../domain/conversation-state-machine";
import { emitAlarmTelemetry, emitTransitionTelemetry } from "./conversation-telemetry";
import type {
  AgentObservationKind,
  AlarmExecution,
  ApplyEventCommand,
  ApplyEventRejectionReason,
  ApplyEventResult,
  BeginLiveKitProvisioningCommand,
  BeginLiveKitProvisioningResult,
  BeginLiveKitShutdownCommand,
  BeginLiveKitShutdownResult,
  CompleteLiveKitProvisioningCommand,
  CompleteLiveKitShutdownCommand,
  InitializeResult,
  LiveKitMediaObservationKind,
  LiveKitProvisioningReady,
  LiveKitTransportEvidence,
  RecordAgentObservationCommand,
  RecordLiveKitMediaObservationCommand,
  TransitionReceipt,
} from "./conversation-session-contract";
import {
  LIVEKIT_SHUTDOWN_OUTBOX_KEY,
  SNAPSHOT_KEY,
  SNAPSHOT_SCHEMA_VERSION,
  decodeSnapshot,
  receiptKey,
  type PersistedSnapshot,
} from "./conversation-session-storage";
import { LiveKitCoordinationStore } from "./livekit-coordination-store";
import { toConversationStateDto } from "../worker/http/conversation-state-dto";
import {
  LIVEKIT_SHUTDOWN_MESSAGE_VERSION,
  type LiveKitShutdownMessage,
} from "../shared/livekit-shutdown";
import {
  AckOutcomeCode,
  BrowserMessageType,
  ProtocolErrorCode,
  ServerMessageType,
  WIRE_PROTOCOL_VERSION,
  WIRE_SUBPROTOCOL,
  WireProtocolError,
  decodeBrowserMessage,
  encodeWireMessage,
  type BrowserWireMessage,
  type MessageAckBody,
  type ServerWireMessage,
} from "../shared/protocol/conversation-wire";

const INTERNAL_CONVERSATION_HEADER = "X-Conversation-Id";
const CLIENT_WEBSOCKET_TAG = "conversation-client";

interface ClientSocketAttachment {
  readonly protocolVersion: typeof WIRE_PROTOCOL_VERSION;
  readonly phase: "awaiting_hello" | "active";
  readonly connectionId: string | null;
  readonly transportEpoch: number | null;
  readonly connectedAt: number;
}

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

class AlarmTransitionRejectedError extends Error {
  constructor(reason: ApplyEventRejectionReason) {
    super(`Alarm transition was unexpectedly rejected: ${reason}`);
    this.name = "AlarmTransitionRejectedError";
  }
}

/** One named Durable Object instance owns one conversation aggregate. */
export class ConversationSession extends DurableObject<Env> {
  private readonly liveKit = new LiveKitCoordinationStore(this.ctx.storage);

  override async fetch(request: Request): Promise<Response> {
    const conversationId = request.headers.get(INTERNAL_CONVERSATION_HEADER);
    if (
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      conversationId === null ||
      conversationId !== this.ctx.id.name
    ) {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    if ((await this.getState()) === null) {
      return new Response("Conversation not found", { status: 404 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [CLIENT_WEBSOCKET_TAG]);
    server.serializeAttachment({
      protocolVersion: WIRE_PROTOCOL_VERSION,
      phase: "awaiting_hello",
      connectionId: null,
      transportEpoch: null,
      connectedAt: Date.now(),
    } satisfies ClientSocketAttachment);

    return new Response(null, {
      status: 101,
      headers: { "Sec-WebSocket-Protocol": WIRE_SUBPROTOCOL },
      webSocket: client,
    });
  }

  override async webSocketMessage(ws: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    if (typeof rawMessage === "string") {
      this.sendProtocolError(ws, null, ProtocolErrorCode.MalformedEnvelope, null);
      ws.close(1002, "Binary messages required");
      return;
    }

    let message: BrowserWireMessage;
    try {
      message = decodeBrowserMessage(rawMessage);
    } catch (error) {
      const protocolError =
        error instanceof WireProtocolError
          ? error
          : new WireProtocolError(ProtocolErrorCode.InternalError);
      const state = await this.getState();
      this.sendProtocolError(
        ws,
        protocolError.messageId,
        protocolError.code,
        state?.revision ?? null,
      );
      if (
        protocolError.code === ProtocolErrorCode.MalformedEnvelope ||
        protocolError.code === ProtocolErrorCode.UnsupportedVersion ||
        protocolError.code === ProtocolErrorCode.MessageTooLarge
      ) {
        ws.close(
          protocolError.code === ProtocolErrorCode.MessageTooLarge ? 1009 : 1002,
          "Protocol violation",
        );
      }
      return;
    }

    try {
      await this.handleBrowserMessage(ws, message);
    } catch (error) {
      console.error(
        JSON.stringify({
          kind: "conversation_websocket_error",
          sessionId: this.ctx.id.name ?? null,
          messageType: message[1],
          error: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      const state = await this.getState();
      this.sendProtocolError(
        ws,
        message[2],
        ProtocolErrorCode.InternalError,
        state?.revision ?? null,
      );
    }
  }

  override async webSocketClose(
    _ws: WebSocket,
    code: number,
    _reason: string,
    wasClean: boolean,
  ): Promise<void> {
    console.log(
      JSON.stringify({
        kind: "conversation_websocket_closed",
        sessionId: this.ctx.id.name ?? null,
        code,
        wasClean,
      }),
    );
  }

  override async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error(
      JSON.stringify({
        kind: "conversation_websocket_error",
        sessionId: this.ctx.id.name ?? null,
        error: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }

  async initialize(sessionId: ConversationSessionId, at: UnixMillis): Promise<InitializeResult> {
    if (this.ctx.id.name !== sessionId) {
      return {
        status: "rejected",
        reason: "identity_mismatch",
        state: decodeSnapshot(this.ctx.storage.kv.get<PersistedSnapshot>(SNAPSHOT_KEY)),
      };
    }
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await this.readState(transaction);
      if (current !== null) {
        await reconcileAlarm(transaction, current);
        return current.data.sessionId === sessionId
          ? ({ status: "existing", state: current } as const)
          : ({ status: "rejected", reason: "already_initialized", state: current } as const);
      }
      const state = createConversation(sessionId, at);
      await this.writeState(transaction, state);
      await reconcileAlarm(transaction, state);
      return { status: "initialized", state } as const;
    });
  }

  getState(): ConversationState | null {
    return decodeSnapshot(this.ctx.storage.kv.get<PersistedSnapshot>(SNAPSHOT_KEY));
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
    const result = await this.ctx.storage.transaction((transaction) =>
      this.applyEventInTransaction(transaction, command),
    );
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
      this.broadcastStateSnapshot(result.state);
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
      const execution = await this.ctx.storage.transaction<AlarmExecution>(async (transaction) => {
        const state = await this.readState(transaction);
        if (state === null) {
          await transaction.deleteAlarm();
          return {
            outcome: "no_state",
            state: null,
            deadline: null,
            event: null,
            transition: null,
          };
        }
        const deadline = deadlineForState(state);
        const event = deadlineEventForState(state, now);
        context = { state, deadline, event };
        if (deadline === null || event === null) {
          await transaction.deleteAlarm();
          return { outcome: "no_deadline", state, deadline: null, event: null, transition: null };
        }
        if (Number(now) < Number(deadline)) {
          await transaction.setAlarm(Number(deadline));
          return { outcome: "rescheduled_early", state, deadline, event, transition: null };
        }
        const transition = await this.applyEventInTransaction(transaction, {
          expectedRevision: state.revision,
          event,
        });
        if (transition.outcome === "rejected") {
          throw new AlarmTransitionRejectedError(transition.reason);
        }
        return {
          outcome: transition.outcome === "applied" ? "transition_applied" : "transition_duplicate",
          state,
          deadline,
          event,
          transition,
        };
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

  private async handleBrowserMessage(ws: WebSocket, message: BrowserWireMessage): Promise<void> {
    const [, type, messageId, body] = message;
    const attachment = socketAttachment(ws);
    if (type === BrowserMessageType.ClientHello) {
      if (attachment.phase !== "awaiting_hello") {
        this.sendProtocolError(ws, messageId, ProtocolErrorCode.MessageNotAllowedInState, null);
        return;
      }
      await this.handleClientHello(ws, messageId, body);
      return;
    }
    if (attachment.phase !== "active" || attachment.connectionId === null) {
      this.sendProtocolError(ws, messageId, ProtocolErrorCode.Unauthorized, null);
      ws.close(1008, "Client hello required");
      return;
    }

    switch (type) {
      case BrowserMessageType.SessionReady:
      case BrowserMessageType.TransportStatus:
      case BrowserMessageType.SessionClosed:
      case BrowserMessageType.ArtifactStatus:
        await this.acknowledgeBrowserObservation(ws, messageId);
        return;
      case BrowserMessageType.EndRequested:
        await this.applyFromSocket(ws, messageId, body.expectedRevision, {
          type: ConversationEventType.EndRequested,
          eventId: `client:${messageId}`,
          at: value.unixMillis(body.observedAt),
          reason: "user_requested",
          endingDeadlineAt: value.unixMillis(body.observedAt + ALARM_SHUTDOWN_GRACE_MS),
        });
        return;
      case BrowserMessageType.ClientPing: {
        const state = await this.getState();
        this.sendWire(ws, [
          WIRE_PROTOCOL_VERSION,
          ServerMessageType.ServerPing,
          crypto.randomUUID(),
          { clientSentAt: body.sentAt, serverSentAt: Date.now() },
        ]);
        if (state !== null) this.sendAck(ws, messageId, AckOutcomeCode.Accepted, state);
        return;
      }
    }
  }

  private async handleClientHello(
    ws: WebSocket,
    messageId: string,
    body: Extract<
      BrowserWireMessage,
      readonly [1, BrowserMessageType.ClientHello, string, unknown]
    >[3],
  ): Promise<void> {
    const state = await this.getState();
    if (
      state === null ||
      body.conversationId !== state.data.sessionId ||
      body.conversationId !== this.ctx.id.name
    ) {
      this.sendProtocolError(
        ws,
        messageId,
        ProtocolErrorCode.ConversationMismatch,
        state?.revision ?? null,
      );
      ws.close(1008, "Conversation mismatch");
      return;
    }
    const epoch = transportEpoch(state.data.transport);
    if (body.requestedEpoch !== null && body.requestedEpoch !== epoch) {
      this.sendProtocolError(ws, messageId, ProtocolErrorCode.StaleTransportEpoch, state.revision);
      ws.close(4001, "Transport epoch superseded");
      return;
    }
    for (const existing of this.ctx.getWebSockets("conversation-client")) {
      if (existing !== ws && socketAttachment(existing).phase === "active") {
        existing.close(4001, "Client connection superseded");
      }
    }
    ws.serializeAttachment({
      protocolVersion: WIRE_PROTOCOL_VERSION,
      phase: "active",
      connectionId: body.connectionId,
      transportEpoch: epoch,
      connectedAt: Date.now(),
    } satisfies ClientSocketAttachment);
    this.sendWire(ws, [
      WIRE_PROTOCOL_VERSION,
      ServerMessageType.ServerHello,
      crypto.randomUUID(),
      {
        connectionId: body.connectionId,
        acceptedEpoch: epoch,
        currentRevision: state.revision,
        currentState: toConversationStateDto(state),
      },
    ]);
    this.sendAck(ws, messageId, AckOutcomeCode.Accepted, state);
  }

  private async acknowledgeBrowserObservation(ws: WebSocket, messageId: string): Promise<void> {
    const state = await this.getState();
    if (state === null) {
      this.sendProtocolError(ws, messageId, ProtocolErrorCode.InternalError, null);
      return;
    }
    this.sendAck(ws, messageId, AckOutcomeCode.Accepted, state);
    this.sendStateSnapshot(ws, state);
  }

  private async applyFromSocket(
    ws: WebSocket,
    messageId: string,
    expectedRevision: number,
    event: ConversationEvent,
  ): Promise<void> {
    const result = await this.applyEvent({ expectedRevision, event });
    this.sendApplyResult(ws, messageId, result);
    if (result.outcome !== "rejected") {
      const attachment = socketAttachment(ws);
      ws.serializeAttachment({
        ...attachment,
        transportEpoch: transportEpoch(result.state.data.transport),
      } satisfies ClientSocketAttachment);
    }
  }

  private sendApplyResult(ws: WebSocket, messageId: string, result: ApplyEventResult): void {
    const state = result.state;
    if (state === null) {
      this.sendProtocolError(ws, messageId, ProtocolErrorCode.ConversationMismatch, null);
      return;
    }
    const outcome =
      result.outcome === "applied"
        ? AckOutcomeCode.Accepted
        : result.outcome === "duplicate"
          ? AckOutcomeCode.Duplicate
          : result.reason === "revision_conflict"
            ? AckOutcomeCode.StaleRevision
            : AckOutcomeCode.Rejected;
    this.sendAck(ws, messageId, outcome, state);
    this.sendStateSnapshot(ws, state);
  }

  private sendAck(
    ws: WebSocket,
    messageId: string,
    outcome: AckOutcomeCode,
    state: ConversationState,
  ): void {
    const body: MessageAckBody = {
      acknowledgedMessageId: messageId,
      outcome,
      currentRevision: state.revision,
      currentState: state.tag,
    };
    this.sendWire(ws, [
      WIRE_PROTOCOL_VERSION,
      ServerMessageType.MessageAck,
      crypto.randomUUID(),
      body,
    ]);
  }

  private sendStateSnapshot(ws: WebSocket, state: ConversationState): void {
    this.sendWire(ws, [
      WIRE_PROTOCOL_VERSION,
      ServerMessageType.StateSnapshot,
      crypto.randomUUID(),
      { revision: state.revision, state: toConversationStateDto(state) },
    ]);
  }

  private broadcastStateSnapshot(state: ConversationState): void {
    for (const ws of this.ctx.getWebSockets(CLIENT_WEBSOCKET_TAG)) {
      try {
        const attachment = socketAttachment(ws);
        if (attachment.phase === "active") this.sendStateSnapshot(ws, state);
      } catch (error) {
        console.warn(
          JSON.stringify({
            kind: "conversation_snapshot_broadcast_failed",
            sessionId: this.ctx.id.name ?? null,
            revision: state.revision,
            error: error instanceof Error ? error.name : "UnknownError",
          }),
        );
        ws.close(1011, "Snapshot delivery failed");
      }
    }
  }

  private sendProtocolError(
    ws: WebSocket,
    messageId: string | null,
    code: ProtocolErrorCode,
    currentRevision: number | null,
  ): void {
    this.sendWire(ws, [
      WIRE_PROTOCOL_VERSION,
      ServerMessageType.ProtocolError,
      crypto.randomUUID(),
      { acknowledgedMessageId: messageId, code, currentRevision },
    ]);
  }

  private sendWire(ws: WebSocket, message: ServerWireMessage): void {
    ws.send(encodeWireMessage(message));
  }

  private async applyEventInTransaction(
    transaction: DurableObjectTransaction,
    command: ApplyEventCommand,
  ): Promise<ApplyEventResult> {
    const receipt = await transaction.get<TransitionReceipt>(receiptKey(command.event.eventId));
    const current = await this.readState(transaction);
    if (receipt !== undefined) {
      if (current === null)
        throw new Error("Transition receipt exists without a conversation snapshot");
      await reconcileAlarm(transaction, current);
      return { outcome: "duplicate", state: current, receipt };
    }
    if (current === null) return { outcome: "rejected", reason: "not_initialized", state: null };
    if (current.revision !== command.expectedRevision) {
      return { outcome: "rejected", reason: "revision_conflict", state: current };
    }
    let next: ConversationState;
    try {
      next = transitionRuntime(current, command.event);
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        return { outcome: "rejected", reason: "illegal_transition", state: current };
      }
      if (error instanceof TransitionGuardError) {
        return { outcome: "rejected", reason: "guard_failed", state: current };
      }
      throw error;
    }
    const appliedReceipt: TransitionReceipt = {
      eventId: command.event.eventId,
      eventType: command.event.type,
      outcome: "applied",
      sourceState: current.tag,
      targetState: next.tag,
      sourceRevision: current.revision,
      targetRevision: next.revision,
      appliedAt: command.event.at,
    };
    await this.writeState(transaction, next);
    await transaction.put(receiptKey(command.event.eventId), appliedReceipt);
    if (command.event.type === ConversationEventType.TimeLimitReached) {
      await transaction.put(LIVEKIT_SHUTDOWN_OUTBOX_KEY, {
        version: LIVEKIT_SHUTDOWN_MESSAGE_VERSION,
        conversationId: current.data.sessionId,
        triggerEventId: command.event.eventId,
      } satisfies LiveKitShutdownMessage);
    }
    await reconcileAlarm(transaction, next);
    return { outcome: "applied", state: next, receipt: appliedReceipt };
  }

  private async readState(
    transaction: DurableObjectTransaction,
  ): Promise<ConversationState | null> {
    return decodeSnapshot(await transaction.get<PersistedSnapshot>(SNAPSHOT_KEY));
  }

  private async writeState(
    transaction: DurableObjectTransaction,
    state: ConversationState,
  ): Promise<void> {
    await transaction.put(SNAPSHOT_KEY, {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      state,
    } satisfies PersistedSnapshot);
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

async function reconcileAlarm(
  transaction: DurableObjectTransaction,
  state: ConversationState,
): Promise<void> {
  const deadline = deadlineForState(state);
  if (deadline === null) {
    await transaction.deleteAlarm();
    return;
  }
  await transaction.setAlarm(Number(deadline));
}

function socketAttachment(ws: WebSocket): ClientSocketAttachment {
  const attachment = ws.deserializeAttachment();
  if (typeof attachment === "object" && attachment !== null) {
    return attachment as ClientSocketAttachment;
  }
  return {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    phase: "awaiting_hello",
    connectionId: null,
    transportEpoch: null,
    connectedAt: Date.now(),
  };
}

function transportEpoch(transport: TransportState): number {
  return transport.status === TransportStatus.Idle ? 0 : transport.epoch;
}
