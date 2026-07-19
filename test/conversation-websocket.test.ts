import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { ConversationEventType, value } from "../src/domain/conversation-state-machine";
import { deriveConversationId } from "../src/worker/http/api-security";
import { testSessionCookie } from "./auth-helpers";
import {
  ArtifactStatusCode,
  BrowserMessageType,
  ServerMessageType,
  TransportStatusCode,
  WIRE_PROTOCOL_VERSION,
  WIRE_SUBPROTOCOL,
  decodeServerMessage,
  encodeWireMessage,
  type BrowserWireMessage,
  type ServerWireMessage,
} from "../src/shared/protocol/conversation-wire";

const ORIGIN = "https://api.example.test";
const BROWSER_ORIGIN = "http://localhost:5173";
const ID_SECRET = "test-conversation-id-secret";

async function connect(conversationId: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    new Request(`${ORIGIN}/v1/conversations/${conversationId}/connect`, {
      headers: {
        Upgrade: "websocket",
        Origin: BROWSER_ORIGIN,
        Cookie: await testSessionCookie(),
        "Sec-WebSocket-Protocol": WIRE_SUBPROTOCOL,
      },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("missing websocket");
  socket.binaryType = "arraybuffer";
  socket.accept();
  return socket;
}

async function setup(name: string, start = false) {
  const conversationId = await deriveConversationId(ID_SECRET, name);
  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  await stub.initialize(value.conversationSessionId(conversationId), value.unixMillis(Date.now()));
  if (start) {
    await stub.applyEvent({
      expectedRevision: 0,
      event: {
        type: ConversationEventType.StartRequested,
        eventId: `${name}:start`,
        at: value.unixMillis(Date.now()),
        startDeadlineAt: value.unixMillis(Date.now() + 60_000),
      },
    });
  }
  return { conversationId, stub, socket: await connect(conversationId) };
}

function send(socket: WebSocket, message: BrowserWireMessage): void {
  socket.send(encodeWireMessage(message));
}

async function receive(socket: WebSocket): Promise<ServerWireMessage> {
  const event = await new Promise<MessageEvent>((resolve) =>
    socket.addEventListener("message", resolve, { once: true }),
  );
  const data = event.data;
  if (data instanceof ArrayBuffer) return decodeServerMessage(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return decodeServerMessage(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
    );
  }
  throw new Error("expected binary message");
}

async function hello(socket: WebSocket, conversationId: string, epoch: number) {
  send(socket, [
    WIRE_PROTOCOL_VERSION,
    BrowserMessageType.ClientHello,
    "hello",
    {
      conversationId,
      connectionId: "client-1",
      requestedEpoch: epoch,
      lastKnownRevision: 0,
    },
  ]);
  expect((await receive(socket))[1]).toBe(ServerMessageType.ServerHello);
  expect((await receive(socket))[1]).toBe(ServerMessageType.MessageAck);
}

async function accepted(socket: WebSocket) {
  const ack = await receive(socket);
  const snapshot = await receive(socket);
  expect(ack[1]).toBe(ServerMessageType.MessageAck);
  expect(snapshot[1]).toBe(ServerMessageType.StateSnapshot);
  return snapshot;
}

describe("generic conversation WebSocket", () => {
  it("rejects unauthenticated upgrades", async () => {
    const conversationId = await deriveConversationId(ID_SECRET, "ws-unauthorized");
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/v1/conversations/${conversationId}/connect`, {
        headers: {
          Upgrade: "websocket",
          Origin: BROWSER_ORIGIN,
          "Sec-WebSocket-Protocol": WIRE_SUBPROTOCOL,
        },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("negotiates conversation.v1 and survives hibernation", async () => {
    const { conversationId, stub, socket } = await setup("ws-hibernation");
    await hello(socket, conversationId, 0);
    await evictDurableObject(stub);
    send(socket, [1, BrowserMessageType.ClientPing, "ping", { sentAt: 123 }]);
    expect((await receive(socket))[1]).toBe(ServerMessageType.ServerPing);
    expect((await receive(socket))[1]).toBe(ServerMessageType.MessageAck);
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.getWebSockets("conversation-client")[0]?.deserializeAttachment(),
      ),
    ).toMatchObject({ phase: "active", connectionId: "client-1", transportEpoch: 0 });
    socket.close(1000, "done");
  });

  it("treats browser media status as non-authoritative while accepting end commands", async () => {
    const { conversationId, stub, socket } = await setup("ws-lifecycle", true);
    await hello(socket, conversationId, 1);

    send(socket, [
      1,
      BrowserMessageType.TransportStatus,
      "connected",
      {
        expectedRevision: 1,
        epoch: 1,
        observedAt: Date.now(),
        status: TransportStatusCode.Connected,
      },
    ]);
    await accepted(socket);
    send(socket, [
      1,
      BrowserMessageType.ArtifactStatus,
      "recording",
      {
        expectedRevision: 1,
        observedAt: Date.now(),
        status: ArtifactStatusCode.Recording,
        recordingId: "recording-1",
      },
    ]);
    await accepted(socket);
    send(socket, [
      1,
      BrowserMessageType.SessionReady,
      "ready",
      { expectedRevision: 1, epoch: 1, observedAt: Date.now() },
    ]);
    await accepted(socket);
    send(socket, [
      1,
      BrowserMessageType.SessionClosed,
      "closed-before-provider",
      { expectedRevision: 1, epoch: 1, observedAt: Date.now() },
    ]);
    await accepted(socket);
    expect(await stub.getState()).toMatchObject({ tag: "starting", revision: 1 });

    send(socket, [
      1,
      BrowserMessageType.EndRequested,
      "end",
      { expectedRevision: 1, epoch: 1, observedAt: Date.now() },
    ]);
    await accepted(socket);
    send(socket, [
      1,
      BrowserMessageType.ArtifactStatus,
      "uploading",
      {
        expectedRevision: 2,
        observedAt: Date.now(),
        status: ArtifactStatusCode.Uploading,
        recordingId: "recording-1",
        objectKey: "recordings/1.webm",
      },
    ]);
    await accepted(socket);
    send(socket, [
      1,
      BrowserMessageType.ArtifactStatus,
      "artifact-ready",
      {
        expectedRevision: 2,
        observedAt: Date.now(),
        status: ArtifactStatusCode.Ready,
        recordingId: "recording-1",
        objectKey: "recordings/1.webm",
        etag: "etag-1",
      },
    ]);
    await accepted(socket);
    send(socket, [
      1,
      BrowserMessageType.SessionClosed,
      "closed",
      { expectedRevision: 2, epoch: 1, observedAt: Date.now() },
    ]);
    await accepted(socket);
    expect(await stub.getState()).toMatchObject({ tag: "ending", revision: 2 });
    socket.close(1000, "done");
  });
});
