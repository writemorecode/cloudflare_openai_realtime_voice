import { describe, expect, it } from "vitest";

import {
  decideLiveKitDispatch,
  decideLiveKitEgress,
  describeLiveKitProvisioning,
  validLiveKitDispatch,
  validLiveKitEgress,
} from "../src/worker/integrations/livekit/access-decisions";

const CONVERSATION_ID = "12345678-1234-8234-9234-123456789abc";
const ROOM_NAME = `conversation-${CONVERSATION_ID}`;

describe("LiveKit access decisions", () => {
  it("describes deterministic provider resources", () => {
    expect(describeLiveKitProvisioning(CONVERSATION_ID, ROOM_NAME, 2)).toEqual({
      metadata: JSON.stringify({
        version: 1,
        conversationId: CONVERSATION_ID,
        roomName: ROOM_NAME,
        transportEpoch: 2,
      }),
      expectedR2Key: `conversations/${CONVERSATION_ID}/recording.ogg`,
    });
  });

  it("creates or reuses exactly one correlated dispatch", () => {
    const metadata = describeLiveKitProvisioning(CONVERSATION_ID, ROOM_NAME, 1).metadata;
    const matching = { id: "AD_matching", agentName: "oral-exam-agent", metadata };
    const unrelated = { id: "AD_other", agentName: "other-agent", metadata };

    expect(decideLiveKitDispatch([], metadata)).toEqual({
      status: "ok",
      value: { kind: "create" },
    });
    expect(decideLiveKitDispatch([unrelated, matching], metadata)).toEqual({
      status: "ok",
      value: { kind: "reuse", resource: matching },
    });
    expect(
      decideLiveKitDispatch([matching, { ...matching, id: "AD_duplicate" }], metadata),
    ).toEqual({ status: "error", error: "dispatch_conflict" });
  });

  it("rejects invalid dispatch identifiers", () => {
    const metadata = describeLiveKitProvisioning(CONVERSATION_ID, ROOM_NAME, 1).metadata;
    const dispatch = { id: "", agentName: "oral-exam-agent", metadata };

    expect(decideLiveKitDispatch([dispatch], metadata)).toEqual({
      status: "error",
      error: "dispatch_invalid",
    });
    expect(validLiveKitDispatch(dispatch)).toEqual({ status: "error", error: "dispatch_invalid" });
  });

  it("creates or reuses exactly one active egress", () => {
    const egress = { egressId: "EG_active", active: true };

    expect(decideLiveKitEgress([])).toEqual({ status: "ok", value: { kind: "create" } });
    expect(decideLiveKitEgress([egress])).toEqual({
      status: "ok",
      value: { kind: "reuse", resource: egress },
    });
    expect(decideLiveKitEgress([egress, { egressId: "EG_other", active: true }])).toEqual({
      status: "error",
      error: "egress_conflict",
    });
  });

  it("rejects invalid egress identifiers", () => {
    const egress = { egressId: "", active: true };

    expect(decideLiveKitEgress([egress])).toEqual({ status: "error", error: "egress_invalid" });
    expect(validLiveKitEgress(egress)).toEqual({ status: "error", error: "egress_invalid" });
  });
});
