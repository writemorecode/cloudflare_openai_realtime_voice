import { ALARM_SHUTDOWN_GRACE_MS } from "../domain/conversation-deadlines";
import {
  ConversationEventType,
  TransportStatus,
  value,
  type ConversationEvent,
  type ConversationState,
  type TransportState,
} from "../domain/conversation-state-machine";
import {
  AckOutcomeCode,
  BrowserMessageType,
  ProtocolErrorCode,
  ServerMessageType,
  WIRE_PROTOCOL_VERSION,
  WIRE_SUBPROTOCOL,
  decodeBrowserMessage,
  encodeWireMessage,
  type BrowserWireMessage,
  type MessageAckBody,
  type ServerWireMessage,
} from "@ai-oral-exam/conversation-contract";
import { toConversationStateDto } from "../worker/http/conversation-state-dto";
import type { AggregateStoreResult } from "./conversation-aggregate-store";
import type { ApplyEventCommand, ApplyEventResult } from "./conversation-session-contract";

const INTERNAL_CONVERSATION_HEADER = "X-Conversation-Id";
const CLIENT_WEBSOCKET_TAG = "conversation-client";

interface ClientSocketAttachment {
  readonly protocolVersion: typeof WIRE_PROTOCOL_VERSION;
  readonly phase: "awaiting_hello" | "active";
  readonly connectionId: string | null;
  readonly transportEpoch: number | null;
  readonly connectedAt: number;
}

export interface ConversationSocketCommands {
  getState(): AggregateStoreResult<ConversationState | null>;
  applyEvent(command: ApplyEventCommand): Promise<AggregateStoreResult<ApplyEventResult>>;
}

/** Hosts the hibernatable control-WebSocket protocol for one conversation. */
export class ConversationSocketGateway {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly commands: ConversationSocketCommands,
  ) {}

  async accept(request: Request): Promise<Response> {
    const conversationId = request.headers.get(INTERNAL_CONVERSATION_HEADER);
    if (
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      conversationId === null ||
      conversationId !== this.ctx.id.name
    ) {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const stored = this.commands.getState();
    if (!stored.ok) {
      return new Response("Conversation storage is unavailable", { status: 500 });
    }
    if (stored.value === null) {
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

  async handleMessage(ws: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    if (typeof rawMessage === "string") {
      this.sendProtocolError(ws, null, ProtocolErrorCode.MalformedEnvelope, null);
      ws.close(1002, "Binary messages required");
      return;
    }

    const decoded = decodeBrowserMessage(rawMessage);
    if (!decoded.ok) {
      const protocolError = decoded.error;
      const state = this.stateOrNull();
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
    const message = decoded.value;

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
      const state = this.stateOrNull();
      this.sendProtocolError(
        ws,
        message[2],
        ProtocolErrorCode.InternalError,
        state?.revision ?? null,
      );
    }
  }

  handleClose(code: number, wasClean: boolean): void {
    console.log(
      JSON.stringify({
        kind: "conversation_websocket_closed",
        sessionId: this.ctx.id.name ?? null,
        code,
        wasClean,
      }),
    );
  }

  handleError(error: unknown): void {
    console.error(
      JSON.stringify({
        kind: "conversation_websocket_error",
        sessionId: this.ctx.id.name ?? null,
        error: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }

  broadcastStateSnapshot(state: ConversationState): void {
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
        this.acknowledgeBrowserObservation(ws, messageId);
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
        const state = this.stateOrNull();
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
    const state = this.stateOrNull();
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
    for (const existing of this.ctx.getWebSockets(CLIENT_WEBSOCKET_TAG)) {
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

  private acknowledgeBrowserObservation(ws: WebSocket, messageId: string): void {
    const state = this.stateOrNull();
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
    const stored = await this.commands.applyEvent({ expectedRevision, event });
    if (!stored.ok) {
      this.sendProtocolError(ws, messageId, ProtocolErrorCode.InternalError, null);
      return;
    }
    const result = stored.value;
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
    const encoded = encodeWireMessage(message);
    if (!encoded.ok) {
      console.error(
        JSON.stringify({
          kind: "conversation_websocket_encode_failed",
          sessionId: this.ctx.id.name ?? null,
          code: encoded.error.code,
        }),
      );
      ws.close(1011, "Message encoding failed");
      return;
    }
    ws.send(encoded.value);
  }

  private stateOrNull(): ConversationState | null {
    const stored = this.commands.getState();
    if (stored.ok) return stored.value;
    console.error(
      JSON.stringify({
        kind: "conversation_snapshot_decode_failed",
        sessionId: this.ctx.id.name ?? null,
        error: stored.error.kind,
        schemaVersion:
          stored.error.kind === "unsupported_snapshot_version"
            ? stored.error.schemaVersion
            : undefined,
      }),
    );
    return null;
  }
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
