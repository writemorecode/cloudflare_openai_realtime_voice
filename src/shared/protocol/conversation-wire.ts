/**
 * Runtime-neutral MessagePack contract shared by the Worker HTTP boundary and Durable Object
 * WebSocket implementation. This protocol exposes sanitized DTOs, never internal provider IDs.
 */
import { decode, encode } from "@msgpack/msgpack";
import { z } from "zod";

import {
  ArtifactStatus,
  ConversationStateTag,
  TransportStatus,
} from "../../domain/conversation-state-machine";
import type { ConversationStateDto } from "../../worker/http/conversation-state-dto";

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

const transportDtoSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal(TransportStatus.Idle) }),
  z.object({ status: z.literal(TransportStatus.Connecting), epoch: positiveEpoch }),
  z.object({ status: z.literal(TransportStatus.Connected), epoch: positiveEpoch }),
  z.object({
    status: z.literal(TransportStatus.Reconnecting),
    epoch: positiveEpoch,
    attempt: positiveEpoch,
    lastErrorCode: errorCode,
  }),
  z.object({ status: z.literal(TransportStatus.Closed), epoch: positiveEpoch }),
  z.object({ status: z.literal(TransportStatus.Failed), epoch: finiteInt, errorCode }),
]);
const artifactDtoSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal(ArtifactStatus.Pending) }),
  z.object({ status: z.literal(ArtifactStatus.Recording) }),
  z.object({ status: z.literal(ArtifactStatus.Uploading) }),
  z.object({ status: z.literal(ArtifactStatus.Ready) }),
  z.object({ status: z.literal(ArtifactStatus.Failed), errorCode }),
]);
const stateDtoSchema: z.ZodType<ConversationStateDto> = z.looseObject({
  conversationId: z.string(),
  state: z.enum(ConversationStateTag),
  revision: finiteInt,
  enteredAt: finiteInt,
  updatedAt: finiteInt,
  activeDeadlineAt: finiteInt.nullable(),
  transport: transportDtoSchema,
  artifact: artifactDtoSchema,
}) as unknown as z.ZodType<ConversationStateDto>;

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
  currentState: stateDtoSchema,
});
const stateSnapshotBodySchema: z.ZodType<StateSnapshotBody> = z.object({
  revision: finiteInt,
  state: stateDtoSchema,
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
  constructor(
    readonly code: ProtocolErrorCode,
    readonly messageId: string | null = null,
    cause?: unknown,
  ) {
    super(`Conversation wire protocol error: ${ProtocolErrorCode[code]}`, { cause });
    this.name = "WireProtocolError";
  }
}

export const encodeWireMessage: (message: ServerWireMessage | BrowserWireMessage) => Uint8Array =
  encode;

export function decodeServerMessage(bytes: ArrayBuffer): ServerWireMessage {
  const [version, type, id, body] = decodeEnvelope(bytes);
  try {
    switch (type) {
      case ServerMessageType.ServerHello:
        return [version, type, id, serverHelloBodySchema.parse(body)];
      case ServerMessageType.StateSnapshot:
        return [version, type, id, stateSnapshotBodySchema.parse(body)];
      case ServerMessageType.MessageAck:
        return [version, type, id, messageAckBodySchema.parse(body)];
      case ServerMessageType.ProtocolError:
        return [version, type, id, protocolErrorBodySchema.parse(body)];
      case ServerMessageType.ServerPing:
        return [version, type, id, serverPingBodySchema.parse(body)];
      default:
        throw new WireProtocolError(ProtocolErrorCode.UnknownMessageType, id);
    }
  } catch (error) {
    throw asWireError(error, id);
  }
}

export function decodeBrowserMessage(bytes: ArrayBuffer): BrowserWireMessage {
  const [version, type, id, body] = decodeEnvelope(bytes);
  try {
    switch (type) {
      case BrowserMessageType.ClientHello:
        return [version, type, id, clientHelloBodySchema.parse(body)];
      case BrowserMessageType.SessionReady:
        return [version, type, id, sessionReadyBodySchema.parse(body)];
      case BrowserMessageType.TransportStatus:
        return [version, type, id, transportStatusBodySchema.parse(body)];
      case BrowserMessageType.SessionClosed:
        return [version, type, id, sessionClosedBodySchema.parse(body)];
      case BrowserMessageType.ArtifactStatus:
        return [version, type, id, artifactStatusBodySchema.parse(body)];
      case BrowserMessageType.EndRequested:
        return [version, type, id, endRequestedBodySchema.parse(body)];
      case BrowserMessageType.ClientPing:
        return [version, type, id, clientPingBodySchema.parse(body)];
      default:
        throw new WireProtocolError(ProtocolErrorCode.UnknownMessageType, id);
    }
  } catch (error) {
    throw asWireError(error, id);
  }
}

function decodeEnvelope(bytes: ArrayBuffer): [1, number, string, unknown] {
  if (bytes.byteLength > MAX_WIRE_MESSAGE_BYTES) {
    throw new WireProtocolError(ProtocolErrorCode.MessageTooLarge);
  }
  const decodedResult = decodeMessagePack(bytes);
  if (!decodedResult.success) {
    throw new WireProtocolError(ProtocolErrorCode.MalformedEnvelope, null, decodedResult.error);
  }
  const decoded = decodedResult.value;
  if (!Array.isArray(decoded) || decoded.length !== 4) {
    throw new WireProtocolError(ProtocolErrorCode.MalformedEnvelope);
  }
  const [version, type, id, body] = decoded;
  if (version !== WIRE_PROTOCOL_VERSION) {
    throw new WireProtocolError(
      ProtocolErrorCode.UnsupportedVersion,
      typeof id === "string" ? id : null,
    );
  }
  if (!Number.isInteger(type) || typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw new WireProtocolError(
      ProtocolErrorCode.MalformedEnvelope,
      typeof id === "string" ? id : null,
    );
  }
  return [version, type as number, id, body];
}

function decodeMessagePack(
  bytes: ArrayBuffer,
): Readonly<{ success: true; value: unknown }> | Readonly<{ success: false; error: unknown }> {
  try {
    return { success: true, value: decode(new Uint8Array(bytes)) };
  } catch (error) {
    return { success: false, error };
  }
}

function asWireError(error: unknown, id: string): WireProtocolError {
  if (error instanceof WireProtocolError) return error;
  if (error instanceof z.ZodError) {
    return new WireProtocolError(ProtocolErrorCode.InvalidBody, id, error);
  }
  return new WireProtocolError(ProtocolErrorCode.InternalError, id, error);
}
