import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConversationEventType,
  ConversationStateTag,
  FailureStage,
  TransportStatus,
  value,
  type ConversationEvent,
} from "../src/domain/conversation-state-machine";
import type { ConversationSession } from "../src/durable-object/conversation-session";
import type {
  ApplyEventResult,
  InitializeResult,
} from "../src/durable-object/conversation-session";
import { aggregateValue } from "./aggregate-store-test-utils";

const at = value.unixMillis;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function initialize(name: string) {
  const stub = env.CONVERSATION_SESSIONS.getByName(name);
  const initialized = aggregateValue<InitializeResult>(
    await stub.initialize(value.conversationSessionId(name), at(Date.now())),
  );
  expect(initialized.status).toBe("initialized");
  return stub;
}

async function apply(stub: DurableObjectStub<ConversationSession>, event: ConversationEvent) {
  const current = aggregateValue<
    import("../src/domain/conversation-state-machine").ConversationState | null
  >(await stub.getState());
  if (current === null) expect.fail("missing state");
  const result = aggregateValue<ApplyEventResult>(
    await stub.applyEvent({ expectedRevision: current.revision, event }),
  );
  if (result.outcome !== "applied") expect.fail(`unexpected ${result.outcome}`);
  return result.state;
}

async function toLive(name: string, maximumEndAt: number) {
  const stub = await initialize(name);
  await apply(stub, {
    type: ConversationEventType.StartRequested,
    eventId: `${name}:start`,
    at: at(Date.now()),
    startDeadlineAt: at(Date.now() + 60_000),
  });
  await apply(stub, {
    type: ConversationEventType.TransportConnected,
    eventId: `${name}:connected`,
    at: at(Date.now()),
    epoch: 1,
  });
  await apply(stub, {
    type: ConversationEventType.RecordingStarted,
    eventId: `${name}:recording`,
    at: at(Date.now()),
    recordingId: value.recordingId(`${name}:recording`),
  });
  await apply(stub, {
    type: ConversationEventType.SessionStarted,
    eventId: `${name}:ready`,
    at: at(Date.now()),
    epoch: 1,
    maximumEndAt: at(maximumEndAt),
  });
  return stub;
}

async function alarmTime(stub: DurableObjectStub<ConversationSession>) {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

async function runAt(stub: DurableObjectStub<ConversationSession>, time: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(time);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  vi.useRealTimers();
}

describe("single Durable Object alarm", () => {
  it("schedules start, live-duration, and ending deadlines as state advances", async () => {
    const now = Date.now();
    const stub = await initialize("alarm-sequence");
    await apply(stub, {
      type: ConversationEventType.StartRequested,
      eventId: "sequence:start",
      at: at(now),
      startDeadlineAt: at(now + 60_000),
    });
    expect(await alarmTime(stub)).toBe(now + 60_000);
    await apply(stub, {
      type: ConversationEventType.TransportConnected,
      eventId: "sequence:connected",
      at: at(now + 1),
      epoch: 1,
    });
    await apply(stub, {
      type: ConversationEventType.RecordingStarted,
      eventId: "sequence:recording",
      at: at(now + 2),
      recordingId: value.recordingId("sequence:recording"),
    });
    await apply(stub, {
      type: ConversationEventType.SessionStarted,
      eventId: "sequence:ready",
      at: at(now + 3),
      epoch: 1,
      maximumEndAt: at(now + 120_000),
    });
    expect(await alarmTime(stub)).toBe(now + 120_000);
    await apply(stub, {
      type: ConversationEventType.EndRequested,
      eventId: "sequence:end",
      at: at(now + 4),
      reason: "done",
      endingDeadlineAt: at(now + 15_004),
    });
    expect(await alarmTime(stub)).toBe(now + 15_004);
  });

  it("fails starting on timeout and remains idempotent after eviction", async () => {
    const deadline = Date.now() + 1_000;
    const stub = await initialize("alarm-start-timeout");
    await apply(stub, {
      type: ConversationEventType.StartRequested,
      eventId: "start-timeout:start",
      at: at(Date.now()),
      startDeadlineAt: at(deadline),
    });
    await evictDurableObject(stub);
    await runAt(stub, deadline + 1);
    expect(aggregateValue(await stub.getState())).toMatchObject({
      tag: ConversationStateTag.Failed,
      revision: 2,
      data: { stage: FailureStage.Starting, transport: { status: TransportStatus.Failed } },
    });
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("moves live to ending at the duration limit", async () => {
    const deadline = Date.now() + 1_000;
    const stub = await toLive("12345678-1234-8234-9234-123456789abc", deadline);
    await runAt(stub, deadline + 1);
    expect(aggregateValue(await stub.getState())).toMatchObject({
      tag: ConversationStateTag.Ending,
      data: { target: { kind: "complete", reason: "time_limit_reached" } },
    });
  });

  it("uses the 20-second reconnect deadline before live duration", async () => {
    const now = Date.now();
    const stub = await toLive("alarm-reconnect", now + 120_000);
    await apply(stub, {
      type: ConversationEventType.TransportInterrupted,
      eventId: "reconnect:interrupted",
      at: at(now),
      epoch: 1,
      errorCode: value.errorCode("network.lost"),
      recoveryDeadlineAt: at(now + 20_000),
    });
    expect(await alarmTime(stub)).toBe(now + 20_000);
    await runAt(stub, now + 20_001);
    expect(aggregateValue(await stub.getState())).toMatchObject({
      tag: ConversationStateTag.Failed,
      data: { stage: FailureStage.Transport },
    });
  });

  it("fails an ending conversation whose transport never becomes terminal", async () => {
    const now = Date.now();
    const stub = await toLive("alarm-ending", now + 120_000);
    await apply(stub, {
      type: ConversationEventType.EndRequested,
      eventId: "ending:end",
      at: at(now),
      reason: "done",
      endingDeadlineAt: at(now + 1_000),
    });
    await runAt(stub, now + 1_001);
    expect(aggregateValue(await stub.getState())).toMatchObject({
      tag: ConversationStateTag.Failed,
      data: { stage: FailureStage.Ending },
    });
  });
});
