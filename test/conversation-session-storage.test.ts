import { describe, expect, it } from "vitest";

import {
  SNAPSHOT_SCHEMA_VERSION,
  decodeSnapshot,
  type PersistedSnapshot,
  type SnapshotEnvelope,
} from "../src/durable-object/conversation-session-storage";
import { createConversation, value } from "../src/domain/conversation-state-machine";

describe("conversation snapshot decoding", () => {
  it("returns missing and supported snapshots explicitly", () => {
    expect(decodeSnapshot(undefined)).toEqual({ status: "ok", value: null });

    const state = createConversation(
      value.conversationSessionId("snapshot-result"),
      value.unixMillis(1),
    );
    expect(
      decodeSnapshot({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        state,
      } satisfies PersistedSnapshot),
    ).toEqual({ status: "ok", value: state });
  });

  it("returns an error for an unsupported schema version", () => {
    expect(
      decodeSnapshot({
        schemaVersion: 2,
        state: createConversation(
          value.conversationSessionId("snapshot-version"),
          value.unixMillis(1),
        ),
      } satisfies SnapshotEnvelope),
    ).toEqual({
      status: "error",
      error: { kind: "unsupported_snapshot_version", schemaVersion: 2 },
    });
  });
});
