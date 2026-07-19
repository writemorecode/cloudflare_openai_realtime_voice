import { describe, expect, it } from "vitest";

import {
  dispatchMetadataForJob,
  parseDispatchMetadata,
  syntheticDispatchMetadata,
} from "../src/dispatch-metadata.js";

const conversationId = "e570d451-98dc-4ba8-867b-735c652114b7";

describe("parseDispatchMetadata", () => {
  it("accepts versioned, correlated dispatch metadata", () => {
    expect(
      parseDispatchMetadata(
        JSON.stringify({
          version: 1,
          conversationId,
          roomName: `conversation-${conversationId}`,
          transportEpoch: 1,
        }),
      ),
    ).toEqual({
      version: 1,
      conversationId,
      roomName: `conversation-${conversationId}`,
      transportEpoch: 1,
    });
  });

  it.each([
    ["invalid JSON", "{"],
    [
      "unsupported version",
      JSON.stringify({
        version: 2,
        conversationId,
        roomName: `conversation-${conversationId}`,
        transportEpoch: 1,
      }),
    ],
    [
      "malformed conversation ID",
      JSON.stringify({
        version: 1,
        conversationId: "not-a-uuid",
        roomName: "conversation-not-a-uuid",
        transportEpoch: 1,
      }),
    ],
    [
      "room mismatch",
      JSON.stringify({
        version: 1,
        conversationId,
        roomName: "conversation-e74e2c1d-1b6c-47dc-bda3-af026159945d",
        transportEpoch: 1,
      }),
    ],
    [
      "invalid epoch",
      JSON.stringify({
        version: 1,
        conversationId,
        roomName: `conversation-${conversationId}`,
        transportEpoch: 0,
      }),
    ],
  ])("rejects %s", (_label, metadata) => {
    expect(() => parseDispatchMetadata(metadata)).toThrow("Invalid agent dispatch metadata");
  });

  it("creates explicit local-only synthetic metadata", () => {
    expect(syntheticDispatchMetadata()).toMatchObject({
      version: 1,
      transportEpoch: 1,
    });
  });
});

describe("dispatchMetadataForJob", () => {
  const serializedMetadata = JSON.stringify({
    version: 1,
    conversationId,
    roomName: `conversation-${conversationId}`,
    transportEpoch: 1,
  });

  it("validates against the assigned job room before the RTC room is connected", () => {
    expect(
      dispatchMetadataForJob(
        {
          isFakeJob: false,
          job: {
            metadata: serializedMetadata,
            room: { name: `conversation-${conversationId}` },
          },
          room: { name: "" },
        },
        false,
      ),
    ).toMatchObject({ conversationId, roomName: `conversation-${conversationId}` });
  });

  it.each([
    ["missing", undefined],
    ["mismatched", { name: "conversation-e74e2c1d-1b6c-47dc-bda3-af026159945d" }],
  ])("rejects a %s assigned job room", (_label, room) => {
    expect(() =>
      dispatchMetadataForJob(
        {
          isFakeJob: false,
          job: { metadata: serializedMetadata, room },
          room: { name: `conversation-${conversationId}` },
        },
        false,
      ),
    ).toThrow("Agent dispatch room does not match the assigned room");
  });
});
