/** Verifies agent-session orchestration and lifecycle signal reporting. */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { RealtimeLifecycleObserver } from "../src/model.js";
import { NoopAgentLifecycleReporter } from "../src/reporter.js";
import {
  BEGIN_EXAMINATION_INSTRUCTIONS,
  INITIAL_GREETING_INSTRUCTIONS,
  runAgentJob,
} from "../src/runtime.js";

const metadata = {
  version: 1 as const,
  conversationId: "e570d451-98dc-4ba8-867b-735c652114b7",
  roomName: "conversation-e570d451-98dc-4ba8-867b-735c652114b7" as const,
  transportEpoch: 1,
};

class TestAgentSession extends EventEmitter {
  readonly start = vi.fn(async () => undefined);
  readonly generateReply = vi.fn(async () => undefined);
}

describe("runAgentJob", () => {
  it("waits for provider readiness before reporting readiness and greeting", async () => {
    const calls: string[] = [];
    const reporter = {
      ...new NoopAgentLifecycleReporter(),
      realtimeReady: vi.fn(async () => {
        calls.push("ready");
      }),
      realtimeFailed: vi.fn(async () => undefined),
      sessionClosed: vi.fn(async () => undefined),
    };
    const session = new TestAgentSession();
    session.start.mockImplementation(async () => {
      calls.push("start");
    });
    session.generateReply.mockImplementation(async () => {
      calls.push("greet");
    });

    await runAgentJob({
      metadata,
      room: {},
      connect: async () => {
        calls.push("connect");
      },
      createSession: (observer) => {
        calls.push("create");
        queueMicrotask(() => {
          calls.push("provider-ready");
          observer.ready();
        });
        return session;
      },
      createAssistant: () => ({}),
      reporter,
    });

    expect(calls).toEqual(["create", "start", "provider-ready", "connect", "ready", "greet"]);
    expect(session.generateReply).toHaveBeenCalledWith({
      instructions: INITIAL_GREETING_INSTRUCTIONS,
    });
    expect(reporter.realtimeReady).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: expect.stringContaining("realtime-ready") }),
    );
  });

  it("reports a sanitized fatal initialization failure", async () => {
    const reporter = {
      ...new NoopAgentLifecycleReporter(),
      realtimeReady: vi.fn(async () => undefined),
      realtimeFailed: vi.fn(async () => undefined),
      sessionClosed: vi.fn(async () => undefined),
    };

    await expect(
      runAgentJob({
        metadata,
        room: {},
        connect: async () => undefined,
        createSession: () => {
          const session = new TestAgentSession();
          session.start.mockRejectedValue(new Error("provider secret detail"));
          return session;
        },
        createAssistant: () => ({}),
        reporter,
      }),
    ).rejects.toThrow("agent.initialization_failed");

    expect(reporter.realtimeFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "agent.initialization_failed" }),
    );
    expect(JSON.stringify(reporter.realtimeFailed.mock.calls)).not.toContain(
      "provider secret detail",
    );
  });

  it("can direct the first reply to begin the examination tool workflow", async () => {
    const session = new TestAgentSession();
    await runAgentJob({
      metadata,
      room: {},
      connect: async () => undefined,
      createSession: (observer) => {
        queueMicrotask(() => observer.ready());
        return session;
      },
      createAssistant: () => ({}),
      reporter: new NoopAgentLifecycleReporter(),
      initialReplyInstructions: BEGIN_EXAMINATION_INSTRUCTIONS,
      initialToolName: "get_current_examination_question",
    });

    expect(session.generateReply).toHaveBeenCalledWith({
      instructions: BEGIN_EXAMINATION_INSTRUCTIONS,
      toolChoice: {
        type: "function",
        function: { name: "get_current_examination_question" },
      },
    });
  });

  it("reports initialization failure when the provider rejects readiness", async () => {
    const reporter = {
      ...new NoopAgentLifecycleReporter(),
      realtimeReady: vi.fn(async () => undefined),
      realtimeFailed: vi.fn(async () => undefined),
    };

    await expect(
      runAgentJob({
        metadata,
        room: {},
        connect: async () => undefined,
        createSession: (observer) => {
          queueMicrotask(() => observer.failed());
          return new TestAgentSession();
        },
        createAssistant: () => ({}),
        reporter,
      }),
    ).rejects.toThrow("agent.initialization_failed");

    expect(reporter.realtimeReady).not.toHaveBeenCalled();
    expect(reporter.realtimeFailed).toHaveBeenCalledOnce();
  });

  it("reports interruption, incremented recovery, fatal failure, and closure in order", async () => {
    const calls: string[] = [];
    const reporter = {
      ...new NoopAgentLifecycleReporter(),
      realtimeReady: vi.fn(async () => {
        calls.push("ready");
      }),
      realtimeInterrupted: vi.fn(async () => {
        calls.push("interrupted");
      }),
      realtimeRecovered: vi.fn(async () => {
        calls.push("recovered");
      }),
      realtimeFailed: vi.fn(async () => {
        calls.push("failed");
      }),
      sessionClosed: vi.fn(async () => {
        calls.push("closed");
      }),
    };
    const session = new TestAgentSession();
    let observer: RealtimeLifecycleObserver | undefined;
    let shutdownCallback: (() => Promise<void>) | undefined;

    await runAgentJob({
      metadata,
      room: {},
      connect: async () => undefined,
      createSession: (createdObserver) => {
        observer = createdObserver;
        queueMicrotask(() => createdObserver.ready());
        return session;
      },
      createAssistant: () => ({}),
      reporter,
      registerShutdownCallback: (callback) => {
        shutdownCallback = callback;
      },
    });

    session.emit("error", { error: { recoverable: true } });
    observer?.recovered();
    session.emit("error", { error: { recoverable: false } });
    session.emit("close");
    await shutdownCallback?.();

    expect(calls).toEqual(["ready", "interrupted", "recovered", "failed", "closed"]);
    expect(reporter.realtimeInterrupted).toHaveBeenCalledWith(
      expect.objectContaining({ transportEpoch: 1 }),
    );
    expect(reporter.realtimeRecovered).toHaveBeenCalledWith(
      expect.objectContaining({ transportEpoch: 2 }),
    );
    expect(reporter.realtimeFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        transportEpoch: 2,
        errorCode: "transport.agent_realtime_failed",
      }),
    );
    expect(reporter.sessionClosed).toHaveBeenCalledWith(
      expect.objectContaining({ transportEpoch: 2 }),
    );
  });
});
