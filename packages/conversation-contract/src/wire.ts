/**
 * Runtime-neutral MessagePack contract shared by the Worker HTTP boundary and Durable Object
 * WebSocket implementation. This protocol exposes sanitized DTOs, never internal provider IDs.
 */
import { decode, encode } from "@msgpack/msgpack";
import { Result } from "better-result";
import { z } from "zod";

import { ConversationStateTag, conversationStateSchema, type ConversationStateDto } from "./state";

/** Current version encoded into every conversation wire message. */
export const WIRE_PROTOCOL_VERSION = 1 as const;
/** WebSocket subprotocol negotiated by conversation control clients. */
export const WIRE_SUBPROTOCOL = "conversation.v1";
/** Largest permitted MessagePack envelope, in bytes. */
export const MAX_WIRE_MESSAGE_BYTES = 64 * 1024;

/** Message type codes sent by browser control clients. */
export enum BrowserMessageType {
  ClientHello = 1,
  SessionReady = 2,
  TransportStatus = 3,
  SessionClosed = 4,
  ArtifactStatus = 5,
  EndRequested = 6,
  ClientPing = 7,
}

/** Message type codes sent by the server over the control connection. */
export enum ServerMessageType {
  ServerHello = 101,
  StateSnapshot = 102,
  MessageAck = 103,
  ProtocolError = 104,
  ServerPing = 105,
}

/** Codes that describe control-transport connectivity. */
export enum TransportStatusCode {
  Connected = 1,
  Interrupted = 2,
  Failed = 3,
}

/** Codes that describe recording-artifact progress. */
export enum ArtifactStatusCode {
  Recording = 1,
  Uploading = 2,
  Ready = 3,
  Failed = 4,
}

/** Codes describing whether the server accepted a browser message. */
export enum AckOutcomeCode {
  Accepted = 1,
  Duplicate = 2,
  StaleRevision = 3,
  StaleEpoch = 4,
  Rejected = 5,
}

/** Codes used to report invalid or unauthorized wire-protocol messages. */
export enum ProtocolErrorCode {
  MalformedEnvelope = 1,
  UnsupportedVersion = 2,
  UnknownMessageType = 3,
  InvalidBody = 4,
  MessageTooLarge = 5,
  Unauthorized = 6,
  ConversationMismatch = 7,
  MessageNotAllowedInState = 8,
  StaleTransportEpoch = 9,
  InternalError = 10,
}

/** Validates finite, non-negative integer protocol fields. */
const finiteInt = z.number().int().nonnegative().finite();
/** Validates positive epoch values. */
const positiveEpoch = z.number().int().positive().finite();
/** Validates protocol message IDs. */
const messageId = z.string().min(1).max(128);
/** Validates bounded machine-readable error codes. */
const errorCode = z.string().min(1).max(128);
/** Validates recording object keys. */
const objectKey = z.string().min(1).max(1024);
/** Validates recording identifiers. */
const recordingId = z.string().min(1).max(256);

/** Validates the initial browser control-connection greeting. */
const clientHelloBodySchema = z.object({
  conversationId: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(128),
  requestedEpoch: z.number().int().nonnegative().nullable(),
  lastKnownRevision: finiteInt,
});
/** Validates bodies that identify a state revision and transport epoch. */
const revisionEpochBodySchema = z.object({
  expectedRevision: finiteInt,
  epoch: positiveEpoch,
  observedAt: finiteInt,
});
/** Validates the browser's notification that its realtime session is ready. */
const sessionReadyBodySchema = revisionEpochBodySchema;
/** Validates the browser's notification that its realtime session has closed. */
const sessionClosedBodySchema = revisionEpochBodySchema;
/** Validates a browser control-transport status update. */
const transportStatusBodySchema = revisionEpochBodySchema.extend({
  status: z.enum(TransportStatusCode),
  errorCode: errorCode.optional(),
});
/** Validates a browser recording-artifact status update. */
const artifactStatusBodySchema = z.object({
  expectedRevision: finiteInt,
  observedAt: finiteInt,
  status: z.enum(ArtifactStatusCode),
  recordingId,
  objectKey: objectKey.optional(),
  etag: z.string().min(1).max(256).optional(),
  errorCode: errorCode.optional(),
});
/** Validates a browser request to end a conversation. */
const endRequestedBodySchema = revisionEpochBodySchema;
/** Validates a browser keepalive ping. */
const clientPingBodySchema = z.object({ sentAt: finiteInt });

/** Body of a browser control-connection greeting. */
export type ClientHelloBody = z.infer<typeof clientHelloBodySchema>;
/** Body indicating that the browser's realtime session is ready. */
export type SessionReadyBody = z.infer<typeof sessionReadyBodySchema>;
/** Body reporting a browser control-transport status change. */
export type TransportStatusBody = z.infer<typeof transportStatusBodySchema>;
/** Body indicating that the browser's realtime session has closed. */
export type SessionClosedBody = z.infer<typeof sessionClosedBodySchema>;
/** Body reporting a recording-artifact status change. */
export type ArtifactStatusBody = z.infer<typeof artifactStatusBodySchema>;
/** Body requesting an orderly conversation shutdown. */
export type EndRequestedBody = z.infer<typeof endRequestedBodySchema>;
/** Body sent by a browser keepalive ping. */
export type ClientPingBody = z.infer<typeof clientPingBodySchema>;

/** Server response accepting a browser control connection. */
export interface ServerHelloBody {
  readonly connectionId: string;
  readonly acceptedEpoch: number;
  readonly currentRevision: number;
  readonly currentState: ConversationStateDto;
}
/** Server-provided full conversation-state snapshot. */
export interface StateSnapshotBody {
  readonly revision: number;
  readonly state: ConversationStateDto;
}
/** Server acknowledgement for a browser message. */
export interface MessageAckBody {
  readonly acknowledgedMessageId: string;
  readonly outcome: AckOutcomeCode;
  readonly currentRevision: number;
  readonly currentState: ConversationStateTag;
}
/** Server explanation for a rejected wire-protocol message. */
export interface ProtocolErrorBody {
  readonly acknowledgedMessageId: string | null;
  readonly code: ProtocolErrorCode;
  readonly currentRevision: number | null;
}
/** Server response to a browser keepalive ping. */
export interface ServerPingBody {
  readonly clientSentAt: number;
  readonly serverSentAt: number;
}

/** Validates a server control-connection greeting. */
const serverHelloBodySchema: z.ZodType<ServerHelloBody> = z.object({
  connectionId: z.string().min(1).max(128),
  acceptedEpoch: finiteInt,
  currentRevision: finiteInt,
  currentState: conversationStateSchema,
});
/** Validates a server conversation-state snapshot. */
const stateSnapshotBodySchema: z.ZodType<StateSnapshotBody> = z.object({
  revision: finiteInt,
  state: conversationStateSchema,
});
/** Validates a server acknowledgement for a browser message. */
const messageAckBodySchema: z.ZodType<MessageAckBody> = z.object({
  acknowledgedMessageId: messageId,
  outcome: z.enum(AckOutcomeCode),
  currentRevision: finiteInt,
  currentState: z.enum(ConversationStateTag),
});
/** Validates a server wire-protocol error response. */
const protocolErrorBodySchema: z.ZodType<ProtocolErrorBody> = z.object({
  acknowledgedMessageId: messageId.nullable(),
  code: z.enum(ProtocolErrorCode),
  currentRevision: finiteInt.nullable(),
});
/** Validates a server keepalive-ping response. */
const serverPingBodySchema: z.ZodType<ServerPingBody> = z.object({
  clientSentAt: finiteInt,
  serverSentAt: finiteInt,
});

/** A versioned MessagePack wire envelope with a typed message body. */
export type WireMessage<T extends number, B> = readonly [
  version: typeof WIRE_PROTOCOL_VERSION,
  messageType: T,
  messageId: string,
  body: B,
];

/** Union of all wire messages accepted from browser control clients. */
export type BrowserWireMessage =
  | WireMessage<BrowserMessageType.ClientHello, ClientHelloBody>
  | WireMessage<BrowserMessageType.SessionReady, SessionReadyBody>
  | WireMessage<BrowserMessageType.TransportStatus, TransportStatusBody>
  | WireMessage<BrowserMessageType.SessionClosed, SessionClosedBody>
  | WireMessage<BrowserMessageType.ArtifactStatus, ArtifactStatusBody>
  | WireMessage<BrowserMessageType.EndRequested, EndRequestedBody>
  | WireMessage<BrowserMessageType.ClientPing, ClientPingBody>;

/** Union of all wire messages emitted by the server. */
export type ServerWireMessage =
  | WireMessage<ServerMessageType.ServerHello, ServerHelloBody>
  | WireMessage<ServerMessageType.StateSnapshot, StateSnapshotBody>
  | WireMessage<ServerMessageType.MessageAck, MessageAckBody>
  | WireMessage<ServerMessageType.ProtocolError, ProtocolErrorBody>
  | WireMessage<ServerMessageType.ServerPing, ServerPingBody>;

/** Error returned when a wire message cannot be encoded, decoded, or validated. */
export class WireProtocolError extends Error {
  /** Alias for the acknowledged message ID retained for Error consumers. */
  readonly messageId: string | null;

  /** Creates a protocol error and associates it with a message when available. */
  constructor(
    readonly code: ProtocolErrorCode,
    readonly acknowledgedMessageId: string | null = null,
    cause?: unknown,
  ) {
    super(`Conversation wire protocol error: ${ProtocolErrorCode[code]}`, { cause });
    this.messageId = acknowledgedMessageId;
    this.name = "WireProtocolError";
  }
}

/** Encodes a typed wire message into a MessagePack byte sequence. */
export function encodeWireMessage(
  message: ServerWireMessage | BrowserWireMessage,
): Result<Uint8Array, WireProtocolError> {
  return Result.try({
    try: () => encode(message),
    catch: (cause) => new WireProtocolError(ProtocolErrorCode.InternalError, null, cause),
  });
}

/** Decodes and validates a wire message received from the server. */
export function decodeServerMessage(
  bytes: ArrayBuffer,
): Result<ServerWireMessage, WireProtocolError> {
  const envelope = decodeEnvelope(bytes);
  if (!envelope.isOk()) return Result.err(envelope.error);
  const [version, type, id, body] = envelope.value;
  switch (type) {
    case ServerMessageType.ServerHello:
      return serverMessage(version, type, id, body, serverHelloBodySchema);
    case ServerMessageType.StateSnapshot:
      return serverMessage(version, type, id, body, stateSnapshotBodySchema);
    case ServerMessageType.MessageAck:
      return serverMessage(version, type, id, body, messageAckBodySchema);
    case ServerMessageType.ProtocolError:
      return serverMessage(version, type, id, body, protocolErrorBodySchema);
    case ServerMessageType.ServerPing:
      return serverMessage(version, type, id, body, serverPingBodySchema);
    default:
      return Result.err(new WireProtocolError(ProtocolErrorCode.UnknownMessageType, id));
  }
}

/** Decodes and validates a wire message received from a browser client. */
export function decodeBrowserMessage(
  bytes: ArrayBuffer,
): Result<BrowserWireMessage, WireProtocolError> {
  const envelope = decodeEnvelope(bytes);
  if (!envelope.isOk()) return Result.err(envelope.error);
  const [version, type, id, body] = envelope.value;
  switch (type) {
    case BrowserMessageType.ClientHello:
      return browserMessage(version, type, id, body, clientHelloBodySchema);
    case BrowserMessageType.SessionReady:
      return browserMessage(version, type, id, body, sessionReadyBodySchema);
    case BrowserMessageType.TransportStatus:
      return browserMessage(version, type, id, body, transportStatusBodySchema);
    case BrowserMessageType.SessionClosed:
      return browserMessage(version, type, id, body, sessionClosedBodySchema);
    case BrowserMessageType.ArtifactStatus:
      return browserMessage(version, type, id, body, artifactStatusBodySchema);
    case BrowserMessageType.EndRequested:
      return browserMessage(version, type, id, body, endRequestedBodySchema);
    case BrowserMessageType.ClientPing:
      return browserMessage(version, type, id, body, clientPingBodySchema);
    default:
      return Result.err(new WireProtocolError(ProtocolErrorCode.UnknownMessageType, id));
  }
}

/** Decodes and checks the common fields of a MessagePack wire envelope. */
function decodeEnvelope(
  bytes: ArrayBuffer,
): Result<readonly [1, number, string, unknown], WireProtocolError> {
  if (bytes.byteLength > MAX_WIRE_MESSAGE_BYTES) {
    return Result.err(new WireProtocolError(ProtocolErrorCode.MessageTooLarge));
  }
  const decodedResult = Result.try({
    try: () => decode(new Uint8Array(bytes)),
    catch: (cause) => new WireProtocolError(ProtocolErrorCode.MalformedEnvelope, null, cause),
  });
  if (!decodedResult.isOk()) {
    return Result.err(decodedResult.error);
  }
  const decoded = decodedResult.value;
  if (!Array.isArray(decoded) || decoded.length !== 4) {
    return Result.err(new WireProtocolError(ProtocolErrorCode.MalformedEnvelope));
  }
  const [version, type, id, body] = decoded;
  if (version !== WIRE_PROTOCOL_VERSION) {
    return Result.err(
      new WireProtocolError(
        ProtocolErrorCode.UnsupportedVersion,
        typeof id === "string" ? id : null,
      ),
    );
  }
  if (!Number.isInteger(type) || typeof id !== "string" || id.length === 0 || id.length > 128) {
    return Result.err(
      new WireProtocolError(
        ProtocolErrorCode.MalformedEnvelope,
        typeof id === "string" ? id : null,
      ),
    );
  }
  return Result.ok([version, type as number, id, body]);
}

/** Parses a server message body and returns a typed server envelope. */
function serverMessage<T extends ServerWireMessage[1], B>(
  version: typeof WIRE_PROTOCOL_VERSION,
  type: T,
  id: string,
  body: unknown,
  schema: z.ZodType<B>,
): Result<ServerWireMessage, WireProtocolError> {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? Result.ok([version, type, id, parsed.data] as ServerWireMessage)
    : Result.err(new WireProtocolError(ProtocolErrorCode.InvalidBody, id, parsed.error));
}

/** Parses a browser message body and returns a typed browser envelope. */
function browserMessage<T extends BrowserWireMessage[1], B>(
  version: typeof WIRE_PROTOCOL_VERSION,
  type: T,
  id: string,
  body: unknown,
  schema: z.ZodType<B>,
): Result<BrowserWireMessage, WireProtocolError> {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? Result.ok([version, type, id, parsed.data] as BrowserWireMessage)
    : Result.err(new WireProtocolError(ProtocolErrorCode.InvalidBody, id, parsed.error));
}
