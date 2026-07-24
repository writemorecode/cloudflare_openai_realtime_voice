/**
 * Runtime-neutral MessagePack contract shared by the Worker HTTP boundary and Durable Object
 * WebSocket implementation. This protocol exposes sanitized DTOs, never internal provider IDs.
 */
import { decode, encode } from "@msgpack/msgpack";
import { err, ok, tryCatchSync, type Result } from "@ai-oral-exam/result";
import { z } from "zod";

import { ConversationStateTag, conversationStateSchema, type ConversationStateDto } from "./state";

export const WIRE_PROTOCOL_VERSION = 1 as const;
export const WIRE_SUBPROTOCOL = "conversation.v1";
export const MAX_WIRE_MESSAGE_BYTES = 64 * 1024;

export enum BrowserMessageType {
  ClientHello = 1,
  SessionReady = 2,
  TransportStatus = 3,
  SessionClosed = 4,
  ArtifactStatus = 5,
  EndRequested = 6,
  ClientPing = 7,
}

export enum ServerMessageType {
  ServerHello = 101,
  StateSnapshot = 102,
  MessageAck = 103,
  ProtocolError = 104,
  ServerPing = 105,
}

export enum TransportStatusCode {
  Connected = 1,
  Interrupted = 2,
  Failed = 3,
}

export enum ArtifactStatusCode {
  Recording = 1,
  Uploading = 2,
  Ready = 3,
  Failed = 4,
}

export enum AckOutcomeCode {
  Accepted = 1,
  Duplicate = 2,
  StaleRevision = 3,
  StaleEpoch = 4,
  Rejected = 5,
}

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

const finiteInt = z.number().int().nonnegative().finite();
const positiveEpoch = z.number().int().positive().finite();
const messageId = z.string().min(1).max(128);
const errorCode = z.string().min(1).max(128);
const objectKey = z.string().min(1).max(1024);
const recordingId = z.string().min(1).max(256);

const clientHelloBodySchema = z.object({
  conversationId: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(128),
  requestedEpoch: z.number().int().nonnegative().nullable(),
  lastKnownRevision: finiteInt,
});
const revisionEpochBodySchema = z.object({
  expectedRevision: finiteInt,
  epoch: positiveEpoch,
  observedAt: finiteInt,
});
const sessionReadyBodySchema = revisionEpochBodySchema;
const sessionClosedBodySchema = revisionEpochBodySchema;
const transportStatusBodySchema = revisionEpochBodySchema.extend({
  status: z.enum(TransportStatusCode),
  errorCode: errorCode.optional(),
});
const artifactStatusBodySchema = z.object({
  expectedRevision: finiteInt,
  observedAt: finiteInt,
  status: z.enum(ArtifactStatusCode),
  recordingId,
  objectKey: objectKey.optional(),
  etag: z.string().min(1).max(256).optional(),
  errorCode: errorCode.optional(),
});
const endRequestedBodySchema = revisionEpochBodySchema;
const clientPingBodySchema = z.object({ sentAt: finiteInt });

export type ClientHelloBody = z.infer<typeof clientHelloBodySchema>;
export type SessionReadyBody = z.infer<typeof sessionReadyBodySchema>;
export type TransportStatusBody = z.infer<typeof transportStatusBodySchema>;
export type SessionClosedBody = z.infer<typeof sessionClosedBodySchema>;
export type ArtifactStatusBody = z.infer<typeof artifactStatusBodySchema>;
export type EndRequestedBody = z.infer<typeof endRequestedBodySchema>;
export type ClientPingBody = z.infer<typeof clientPingBodySchema>;

export interface ServerHelloBody {
  readonly connectionId: string;
  readonly acceptedEpoch: number;
  readonly currentRevision: number;
  readonly currentState: ConversationStateDto;
}
export interface StateSnapshotBody {
  readonly revision: number;
  readonly state: ConversationStateDto;
}
export interface MessageAckBody {
  readonly acknowledgedMessageId: string;
  readonly outcome: AckOutcomeCode;
  readonly currentRevision: number;
  readonly currentState: ConversationStateTag;
}
export interface ProtocolErrorBody {
  readonly acknowledgedMessageId: string | null;
  readonly code: ProtocolErrorCode;
  readonly currentRevision: number | null;
}
export interface ServerPingBody {
  readonly clientSentAt: number;
  readonly serverSentAt: number;
}

const serverHelloBodySchema: z.ZodType<ServerHelloBody> = z.object({
  connectionId: z.string().min(1).max(128),
  acceptedEpoch: finiteInt,
  currentRevision: finiteInt,
  currentState: conversationStateSchema,
});
const stateSnapshotBodySchema: z.ZodType<StateSnapshotBody> = z.object({
  revision: finiteInt,
  state: conversationStateSchema,
});
const messageAckBodySchema: z.ZodType<MessageAckBody> = z.object({
  acknowledgedMessageId: messageId,
  outcome: z.enum(AckOutcomeCode),
  currentRevision: finiteInt,
  currentState: z.enum(ConversationStateTag),
});
const protocolErrorBodySchema: z.ZodType<ProtocolErrorBody> = z.object({
  acknowledgedMessageId: messageId.nullable(),
  code: z.enum(ProtocolErrorCode),
  currentRevision: finiteInt.nullable(),
});
const serverPingBodySchema: z.ZodType<ServerPingBody> = z.object({
  clientSentAt: finiteInt,
  serverSentAt: finiteInt,
});

export type WireMessage<T extends number, B> = readonly [
  version: typeof WIRE_PROTOCOL_VERSION,
  messageType: T,
  messageId: string,
  body: B,
];

export type BrowserWireMessage =
  | WireMessage<BrowserMessageType.ClientHello, ClientHelloBody>
  | WireMessage<BrowserMessageType.SessionReady, SessionReadyBody>
  | WireMessage<BrowserMessageType.TransportStatus, TransportStatusBody>
  | WireMessage<BrowserMessageType.SessionClosed, SessionClosedBody>
  | WireMessage<BrowserMessageType.ArtifactStatus, ArtifactStatusBody>
  | WireMessage<BrowserMessageType.EndRequested, EndRequestedBody>
  | WireMessage<BrowserMessageType.ClientPing, ClientPingBody>;

export type ServerWireMessage =
  | WireMessage<ServerMessageType.ServerHello, ServerHelloBody>
  | WireMessage<ServerMessageType.StateSnapshot, StateSnapshotBody>
  | WireMessage<ServerMessageType.MessageAck, MessageAckBody>
  | WireMessage<ServerMessageType.ProtocolError, ProtocolErrorBody>
  | WireMessage<ServerMessageType.ServerPing, ServerPingBody>;

export class WireProtocolError extends Error {
  readonly messageId: string | null;

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

export function encodeWireMessage(
  message: ServerWireMessage | BrowserWireMessage,
): Result<Uint8Array, WireProtocolError> {
  return tryCatchSync(
    () => encode(message),
    (cause) => new WireProtocolError(ProtocolErrorCode.InternalError, null, cause),
  );
}

export function decodeServerMessage(
  bytes: ArrayBuffer,
): Result<ServerWireMessage, WireProtocolError> {
  const envelope = decodeEnvelope(bytes);
  if (!envelope.ok) return err(envelope.error);
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
      return err(new WireProtocolError(ProtocolErrorCode.UnknownMessageType, id));
  }
}

export function decodeBrowserMessage(
  bytes: ArrayBuffer,
): Result<BrowserWireMessage, WireProtocolError> {
  const envelope = decodeEnvelope(bytes);
  if (!envelope.ok) return err(envelope.error);
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
      return err(new WireProtocolError(ProtocolErrorCode.UnknownMessageType, id));
  }
}

function decodeEnvelope(
  bytes: ArrayBuffer,
): Result<readonly [1, number, string, unknown], WireProtocolError> {
  if (bytes.byteLength > MAX_WIRE_MESSAGE_BYTES) {
    return err(new WireProtocolError(ProtocolErrorCode.MessageTooLarge));
  }
  const decodedResult = tryCatchSync(
    () => decode(new Uint8Array(bytes)),
    (cause) => new WireProtocolError(ProtocolErrorCode.MalformedEnvelope, null, cause),
  );
  if (!decodedResult.ok) {
    return err(decodedResult.error);
  }
  const decoded = decodedResult.value;
  if (!Array.isArray(decoded) || decoded.length !== 4) {
    return err(new WireProtocolError(ProtocolErrorCode.MalformedEnvelope));
  }
  const [version, type, id, body] = decoded;
  if (version !== WIRE_PROTOCOL_VERSION) {
    return err(
      new WireProtocolError(
        ProtocolErrorCode.UnsupportedVersion,
        typeof id === "string" ? id : null,
      ),
    );
  }
  if (!Number.isInteger(type) || typeof id !== "string" || id.length === 0 || id.length > 128) {
    return err(
      new WireProtocolError(
        ProtocolErrorCode.MalformedEnvelope,
        typeof id === "string" ? id : null,
      ),
    );
  }
  return ok([version, type as number, id, body]);
}

function serverMessage<T extends ServerWireMessage[1], B>(
  version: typeof WIRE_PROTOCOL_VERSION,
  type: T,
  id: string,
  body: unknown,
  schema: z.ZodType<B>,
): Result<ServerWireMessage, WireProtocolError> {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? ok([version, type, id, parsed.data] as ServerWireMessage)
    : err(new WireProtocolError(ProtocolErrorCode.InvalidBody, id, parsed.error));
}

function browserMessage<T extends BrowserWireMessage[1], B>(
  version: typeof WIRE_PROTOCOL_VERSION,
  type: T,
  id: string,
  body: unknown,
  schema: z.ZodType<B>,
): Result<BrowserWireMessage, WireProtocolError> {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? ok([version, type, id, parsed.data] as BrowserWireMessage)
    : err(new WireProtocolError(ProtocolErrorCode.InvalidBody, id, parsed.error));
}
