import { encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";

import {
  ArtifactStatusCode,
  BrowserMessageType,
  ProtocolErrorCode,
  TransportStatusCode,
  WIRE_PROTOCOL_VERSION,
  WIRE_SUBPROTOCOL,
  WireProtocolError,
  decodeBrowserMessage,
  encodeWireMessage,
} from "@ai-oral-exam/conversation-contract";

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("conversation.v1 generic wire protocol", () => {
  it("keeps the requested wire identifier", () => {
    expect(WIRE_PROTOCOL_VERSION).toBe(1);
    expect(WIRE_SUBPROTOCOL).toBe("conversation.v1");
  });

  it("round-trips session-ready, transport, closed, artifact, end, and ping messages", () => {
    const messages = [
      [
        1,
        BrowserMessageType.SessionReady,
        "ready",
        { expectedRevision: 3, epoch: 1, observedAt: 10 },
      ],
      [
        1,
        BrowserMessageType.TransportStatus,
        "transport",
        {
          expectedRevision: 4,
          epoch: 1,
          observedAt: 11,
          status: TransportStatusCode.Interrupted,
          errorCode: "network.lost",
        },
      ],
      [
        1,
        BrowserMessageType.SessionClosed,
        "closed",
        { expectedRevision: 5, epoch: 2, observedAt: 12 },
      ],
      [
        1,
        BrowserMessageType.ArtifactStatus,
        "artifact",
        {
          expectedRevision: 6,
          observedAt: 13,
          status: ArtifactStatusCode.Ready,
          recordingId: "recording-1",
          objectKey: "recordings/1.webm",
          etag: "etag-1",
        },
      ],
      [
        1,
        BrowserMessageType.EndRequested,
        "end",
        { expectedRevision: 7, epoch: 2, observedAt: 14 },
      ],
      [1, BrowserMessageType.ClientPing, "ping", { sentAt: 15 }],
    ] as const;

    for (const message of messages) {
      const encoded = encodeWireMessage(message);
      expect(encoded).toMatchObject({ status: "ok" });
      if (!encoded.isOk()) expect.fail(`wire encoding failed unexpectedly: ${encoded.error}`);
      expect(decodeBrowserMessage(buffer(encoded.value))).toEqual({ status: "ok", value: message });
    }
  });

  it("rejects unsupported versions, unknown types, malformed envelopes, and invalid bodies", () => {
    const cases: Array<[unknown, ProtocolErrorCode]> = [
      [
        [2, BrowserMessageType.ClientPing, "id", { sentAt: 1 }],
        ProtocolErrorCode.UnsupportedVersion,
      ],
      [[1, 99, "id", {}], ProtocolErrorCode.UnknownMessageType],
      [[1, BrowserMessageType.ClientPing], ProtocolErrorCode.MalformedEnvelope],
      [
        [
          1,
          BrowserMessageType.SessionClosed,
          "id",
          { expectedRevision: 1, epoch: 0, observedAt: 1 },
        ],
        ProtocolErrorCode.InvalidBody,
      ],
    ];
    for (const [message, code] of cases) {
      const decoded = decodeBrowserMessage(buffer(encode(message)));
      expect(decoded).toMatchObject({ status: "error" });
      if (decoded.isOk()) expect.fail("expected decoding to fail");
      expect(decoded.error).toBeInstanceOf(WireProtocolError);
      expect(decoded.error.code).toBe(code);
    }
  });
});
