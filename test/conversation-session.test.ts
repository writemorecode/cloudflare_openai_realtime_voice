import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationEventType,
  ConversationStateTag,
  value,
} from "../src/domain/conversation-state-machine";
import type {
  ApplyEventResult,
  TransitionTelemetryRecord,
} from "../src/durable-object/conversation-session";

const at = value.unixMillis;

function session(name: string) {
  return {
    sessionId: value.conversationSessionId(name),
    stub: env.CONVERSATION_SESSIONS.getByName(name),
  };
}

function startEvent(eventId = "event-start") {
  return {
    type: ConversationEventType.StartRequested,
    eventId,
    at: at(1_000),
    startDeadlineAt: at(Date.now() + 60_000),
  } as const;
}

async function initialize(name: string) {
  const target = session(name);
  expect((await target.stub.initialize(target.sessionId, at(0))).status).toBe("initialized");
  return target;
}

describe("ConversationSession persistence and concurrency", () => {
  it("initializes once and rejects an identity mismatch", async () => {
    const target = session("session-init");
    expect((await target.stub.initialize(target.sessionId, at(100))).status).toBe("initialized");
    const existing = await target.stub.initialize(target.sessionId, at(999));
    expect(existing).toMatchObject({ status: "existing", state: { revision: 0, enteredAt: 100 } });

    const wrong = session("session-correct");
    expect(
      await wrong.stub.initialize(value.conversationSessionId("session-wrong"), at(0)),
    ).toEqual({ status: "rejected", reason: "identity_mismatch", state: null });
  });

  it("survives eviction and preserves the aggregate revision", async () => {
    const { stub } = await initialize("session-eviction");
    await stub.applyEvent({ expectedRevision: 0, event: startEvent() });
    await evictDurableObject(stub);
    expect(await env.CONVERSATION_SESSIONS.getByName("session-eviction").getState()).toMatchObject({
      tag: ConversationStateTag.Starting,
      revision: 1,
    });
  });

  it("deduplicates receipts before checking the stale expected revision", async () => {
    const { stub } = await initialize("session-duplicate");
    const event = startEvent();
    const applied = await stub.applyEvent({ expectedRevision: 0, event });
    const duplicate = await stub.applyEvent({ expectedRevision: 999, event });
    expect(applied.outcome).toBe("applied");
    expect(duplicate.outcome).toBe("duplicate");
    if (applied.outcome === "applied" && duplicate.outcome === "duplicate") {
      expect(duplicate.receipt).toEqual(applied.receipt);
      expect(duplicate.state.revision).toBe(1);
    }
  });

  it("rejects revision conflicts, illegal transitions, and failed guards without persisting", async () => {
    const { stub } = await initialize("session-rejections");
    await stub.applyEvent({ expectedRevision: 0, event: startEvent() });
    const stale = await stub.applyEvent({
      expectedRevision: 0,
      event: {
        type: ConversationEventType.EndRequested,
        eventId: "stale",
        at: at(2_000),
        reason: "done",
        endingDeadlineAt: at(5_000),
      },
    });
    const guarded = await stub.applyEvent({
      expectedRevision: 1,
      event: {
        type: ConversationEventType.SessionStarted,
        eventId: "guarded",
        at: at(2_000),
        epoch: 1,
        maximumEndAt: at(9_000),
      },
    });

    const other = await initialize("session-illegal");
    const illegal = await other.stub.applyEvent({
      expectedRevision: 0,
      event: {
        type: ConversationEventType.TransportConnected,
        eventId: "illegal",
        at: at(1),
        epoch: 1,
      },
    });
    expect(stale).toMatchObject({ outcome: "rejected", reason: "revision_conflict" });
    expect(guarded).toMatchObject({ outcome: "rejected", reason: "guard_failed" });
    expect(illegal).toMatchObject({ outcome: "rejected", reason: "illegal_transition" });
    expect((await stub.getState())?.revision).toBe(1);
  });

  it("allows only one command to win a revision", async () => {
    const { stub } = await initialize("session-concurrent");
    const results = await Promise.all([
      stub.applyEvent({ expectedRevision: 0, event: startEvent("start-a") }),
      stub.applyEvent({
        expectedRevision: 0,
        event: {
          type: ConversationEventType.EndRequested,
          eventId: "cancel-b",
          at: at(1),
          reason: "cancelled",
          endingDeadlineAt: at(10),
        },
      }),
    ]);
    expect(results.filter((result) => result.outcome === "applied")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "rejected")).toHaveLength(1);
  });
});

describe("ConversationSession transition telemetry", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("records applied, duplicate, conflict, illegal, and guard outcomes without event data", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { stub } = await initialize("session-telemetry");
    const event = startEvent();
    await stub.applyEvent({ expectedRevision: 0, event });
    await stub.applyEvent({ expectedRevision: 0, event });
    await stub.applyEvent({
      expectedRevision: 0,
      event: {
        type: ConversationEventType.EndRequested,
        eventId: "conflict",
        at: at(2),
        reason: "done",
        endingDeadlineAt: at(20),
      },
    });
    await stub.applyEvent({
      expectedRevision: 1,
      event: {
        type: ConversationEventType.SessionStarted,
        eventId: "guard",
        at: at(2),
        epoch: 1,
        maximumEndAt: at(20),
      },
    });
    const illegal = await initialize("session-telemetry-illegal");
    await illegal.stub.applyEvent({
      expectedRevision: 0,
      event: {
        type: ConversationEventType.TransportConnected,
        eventId: "illegal",
        at: at(1),
        epoch: 1,
      },
    });

    const records = log.mock.calls
      .map(([message]) => JSON.parse(String(message)) as TransitionTelemetryRecord)
      .filter((record) => record.kind === "conversation_transition");
    expect(records.map((record) => record.outcome)).toEqual(
      expect.arrayContaining<ApplyEventResult["outcome"]>(["applied", "duplicate", "rejected"]),
    );
    expect(records.map((record) => record.rejectionReason)).toEqual(
      expect.arrayContaining(["revision_conflict", "illegal_transition", "guard_failed"]),
    );
    expect(records.every((record) => !("event" in record) && !("data" in record))).toBe(true);
  });
});
