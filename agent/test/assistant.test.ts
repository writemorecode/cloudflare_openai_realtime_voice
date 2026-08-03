import { beforeEach, describe, expect, it, vi } from "vitest";

const taskGroupHarness = vi.hoisted(() => {
  type TaskFactory = () => {
    readonly toolCtx: {
      readonly functionTools: Record<
        string,
        {
          execute(
            args: { disposition: "answered" },
            options: {
              ctx: { disallowInterruptions(): void };
              toolCallId: string;
              abortSignal: AbortSignal;
            },
          ): Promise<unknown>;
        }
      >;
    };
  };

  class FakeTaskGroup {
    static instances: FakeTaskGroup[] = [];

    readonly tasks: Array<{
      factory: TaskFactory;
      options: { id: string; description: string };
    }> = [];

    constructor(
      readonly options: {
        chatCtx?: unknown;
        summarizeChatCtx?: boolean;
        onTaskCompleted?: (event: {
          agentTask: ReturnType<TaskFactory>;
          taskId: string;
          result: unknown;
        }) => Promise<void>;
      } = {},
    ) {
      FakeTaskGroup.instances.push(this);
    }

    add(factory: TaskFactory, options: { id: string; description: string }): this {
      this.tasks.push({ factory, options });
      return this;
    }

    async run(): Promise<{ taskResults: Record<string, unknown> }> {
      const taskResults: Record<string, unknown> = {};
      await this.tasks.reduce<Promise<void>>(async (previousTask, taskDefinition) => {
        await previousTask;
        const task = taskDefinition.factory();
        const completionTool = task.toolCtx.functionTools.complete_current_examination_question;
        if (completionTool === undefined) throw new Error("completion tool is missing");
        const result = await completionTool.execute(
          { disposition: "answered" },
          {
            ctx: { disallowInterruptions() {} },
            toolCallId: `complete-${taskDefinition.options.id}`,
            abortSignal: AbortSignal.abort(),
          },
        );
        taskResults[taskDefinition.options.id] = result;
        await this.options.onTaskCompleted?.({
          agentTask: task,
          taskId: taskDefinition.options.id,
          result,
        });
      }, Promise.resolve());
      return { taskResults };
    }
  }

  return { FakeTaskGroup };
});

vi.mock("@livekit/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@livekit/agents")>();
  return {
    ...actual,
    workflows: {
      ...actual.workflows,
      TaskGroup: taskGroupHarness.FakeTaskGroup,
    },
  };
});

import { initializeLogger } from "@livekit/agents";

import { createAssistant } from "../src/assistant.js";
import type {
  CurrentExaminationQuestion,
  ExaminationQuestionClient,
} from "../src/examination-client.js";

const conversationId = "e570d451-98dc-4ba8-867b-735c652114b7";

function resolved<T>(value: T) {
  return vi.fn(async () => value);
}

function resolvedSequence<T>(...values: readonly T[]) {
  const pending = [...values];
  return vi.fn(async () => {
    const next = pending.shift();
    if (next === undefined) throw new Error("mock sequence exhausted");
    return next;
  });
}

initializeLogger({ pretty: false, level: "warn" });

describe("oral examination assistant", () => {
  beforeEach(() => {
    taskGroupHarness.FakeTaskGroup.instances.length = 0;
  });

  it("loads the examiner markdown prompt and exposes only the authoritative start tool", () => {
    const client: ExaminationQuestionClient = {
      getCurrent: vi.fn(),
      completeCurrent: vi.fn(),
    };
    const assistant = createAssistant({
      client,
      conversationId,
    });

    expect(String(assistant.instructions)).toContain("Current Application Tools and MVP Scope");
    expect(String(assistant.instructions)).toContain("human examiner");
    expect(Object.keys(assistant.toolCtx.functionTools)).toEqual([
      "get_current_examination_question",
    ]);
  });

  it("keeps a tool-free assistant for explicit synthetic console jobs", () => {
    const assistant = createAssistant();
    expect(Object.keys(assistant.toolCtx.functionTools)).toEqual([]);
  });

  it("runs all authoritative questions in one shared-context task group", async () => {
    const first = question(1, 2, 5);
    const second = question(2, 2, 6);
    const complete: CurrentExaminationQuestion = {
      status: "complete",
      examinationSessionId: first.examinationSessionId,
      examinationName: first.examinationName,
      subject: first.subject,
      questionCount: 2,
      revision: 7,
    };
    const client: ExaminationQuestionClient = {
      getCurrent: resolved(first),
      completeCurrent: resolvedSequence(second, complete),
    };
    const assistant = createAssistant({ client, conversationId });

    const result = await executeStartTool(assistant);

    expect(result).toEqual({
      status: "complete",
      message:
        "All fixed examination questions are complete. Give the standard brief closing statement now.",
    });
    expect(client.getCurrent).toHaveBeenCalledOnce();
    expect(client.completeCurrent).toHaveBeenNthCalledWith(1, conversationId, {
      questionId: first.question.id,
      expectedRevision: 5,
      disposition: "answered",
    });
    expect(client.completeCurrent).toHaveBeenNthCalledWith(2, conversationId, {
      questionId: second.question.id,
      expectedRevision: 6,
      disposition: "answered",
    });

    const [taskGroup] = taskGroupHarness.FakeTaskGroup.instances;
    expect(taskGroup).toBeDefined();
    expect(taskGroup?.options.chatCtx).toBeDefined();
    expect(taskGroup?.options.summarizeChatCtx).toBe(false);
    expect(taskGroup?.tasks.map(({ options }) => options.id)).toEqual([
      "fixed-question-1",
      "fixed-question-2",
    ]);
  });

  it("returns immediately when authoritative progress is already complete", async () => {
    const client: ExaminationQuestionClient = {
      getCurrent: resolved({
        status: "complete",
        examinationSessionId: "c13475ec-bf0c-4c22-842a-2ef04d160e42",
        examinationName: "Oral assessment",
        subject: "Systems",
        questionCount: 2,
        revision: 7,
      } satisfies CurrentExaminationQuestion),
      completeCurrent: vi.fn(),
    };
    const assistant = createAssistant({ client, conversationId });

    await expect(executeStartTool(assistant)).resolves.toMatchObject({ status: "complete" });
    expect(client.completeCurrent).not.toHaveBeenCalled();
    expect(taskGroupHarness.FakeTaskGroup.instances).toEqual([]);
  });

  it("returns an explicit error result when the task group ends before examination completion", async () => {
    const first = question(1, 1, 5);
    const client: ExaminationQuestionClient = {
      getCurrent: resolved(first),
      completeCurrent: resolved(question(1, 1, 6)),
    };
    const assistant = createAssistant({ client, conversationId });

    await expect(executeStartTool(assistant)).resolves.toEqual({
      status: "error",
      code: "incomplete_examination",
      message:
        "The authoritative examination sequence could not continue. Do not claim completion or invent a question.",
    });
  });
});

function question(
  ordinal: number,
  questionCount: number,
  revision: number,
): Extract<CurrentExaminationQuestion, { status: "question" }> {
  return {
    status: "question",
    examinationSessionId: "c13475ec-bf0c-4c22-842a-2ef04d160e42",
    examinationName: "Oral assessment",
    subject: "Systems",
    question: {
      id:
        ordinal === 1
          ? "3c12686f-fefd-4e50-b58e-b765a223233a"
          : "f831c93d-765c-4782-8540-c826ae32cb35",
      ordinal,
      text: `Fixed question ${ordinal}?`,
    },
    questionCount,
    revision,
  };
}

async function executeStartTool(assistant: ReturnType<typeof createAssistant>): Promise<unknown> {
  const tool = assistant.toolCtx.functionTools.get_current_examination_question;
  if (tool === undefined) throw new Error("start tool is missing");
  return tool.execute({}, {
    ctx: {
      session: {
        currentAgent: assistant,
      },
    },
    toolCallId: "start-examination",
    abortSignal: AbortSignal.abort(),
  } as never);
}
