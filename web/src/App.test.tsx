/** Verifies browser-page authentication, navigation, and live-conversation controls. */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationStateTag,
  TransportStatus,
  ok,
  type ConversationApi,
  type ConversationRuntime,
  type ConversationStateDto,
  type RuntimeEvents,
  type RuntimeFactory,
} from "@ai-oral-exam/conversation-client";
import { ConversationPage, DashboardPage, LoginPage, PostConversationPage } from "./App";

const ID = "12345678-1234-8234-9234-123456789abc";

function state(tag: ConversationStateTag): ConversationStateDto {
  return {
    conversationId: ID,
    state: tag,
    revision: 1,
    enteredAt: 1,
    updatedAt: 1,
    activeDeadlineAt: null,
    transport: { status: "closed", epoch: 1 },
    artifact: { status: "ready" },
    ...(tag === ConversationStateTag.Completed
      ? { completed: { completedAt: 1, terminationReason: "user_requested" } }
      : {}),
  } as ConversationStateDto;
}

function api(overrides: Partial<ConversationApi> = {}): ConversationApi {
  return {
    login: vi.fn().mockResolvedValue(ok({ username: "examiner" })),
    getSession: vi.fn().mockResolvedValue(ok({ username: "examiner" })),
    logout: vi.fn().mockResolvedValue(ok(undefined)),
    createExamination: vi.fn(),
    listExaminations: vi.fn().mockResolvedValue(ok({ examinations: [] })),
    getExamination: vi.fn(),
    createExaminationSession: vi.fn(),
    listExaminationSessions: vi.fn().mockResolvedValue(ok({ sessions: [] })),
    getExaminationSession: vi.fn(),
    recordingUrl: vi.fn(),
    createConversation: vi.fn().mockResolvedValue(ok(state(ConversationStateTag.Created))),
    startConversation: vi.fn(),
    getState: vi.fn().mockResolvedValue(ok(state(ConversationStateTag.Completed))),
    getLiveKitAccess: vi.fn(),
    releaseLiveKitAccess: vi.fn().mockResolvedValue(ok(undefined)),
    websocketUrl: vi.fn(),
    websocketProtocols: vi.fn(),
    ...overrides,
  };
}

describe("conversation pages", () => {
  it("starts an available examination and navigates to its conversation", async () => {
    const navigate = vi.fn();
    const examination = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Distributed systems oral",
      subject: "Computer science",
      questionCount: 2,
      createdAt: 1,
    };
    const conversationApi = api({
      listExaminations: vi.fn().mockResolvedValue(ok({ examinations: [examination] })),
      createExaminationSession: vi.fn().mockResolvedValue(
        ok({
          id: ID,
          examinationId: examination.id,
          examinationName: examination.name,
          subject: examination.subject,
          conversationId: ID,
          questionState: "in_progress",
          currentQuestionOrdinal: 1,
          questionCount: 2,
          createdAt: 1,
          questionsCompletedAt: null,
          conversationState: "created",
          recordingAvailable: false,
        }),
      ),
    });
    render(<DashboardPage api={conversationApi} navigate={navigate} onLogout={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start exam" }));
    expect(navigate).toHaveBeenCalledWith(`/conversation/${ID}`);
  });

  it("requires and submits username and password credentials", async () => {
    const onAuthenticated = vi.fn();
    const conversationApi = api();
    render(<LoginPage api={conversationApi} onAuthenticated={onAuthenticated} />);

    const usernameInput = screen.getByLabelText("Sign in");
    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter your username and password to continue.",
    );
    expect(conversationApi.login).not.toHaveBeenCalled();

    await userEvent.type(usernameInput, "examiner");
    await userEvent.type(passwordInput, "correct horse battery staple");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(conversationApi.login).toHaveBeenCalledWith("examiner", "correct horse battery staple");
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("creates an examination with ordered questions from the dashboard", async () => {
    const conversationApi = api({
      createExamination: vi.fn().mockResolvedValue(
        ok({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "Operating systems oral",
          subject: "Computer science",
          questionCount: 2,
          createdAt: 1,
          questions: [
            {
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              ordinal: 1,
              text: "Explain virtual memory.",
            },
            {
              id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              ordinal: 2,
              text: "What causes deadlock?",
            },
          ],
        }),
      ),
    });
    const rendered = render(
      <DashboardPage api={conversationApi} navigate={vi.fn()} onLogout={vi.fn()} />,
    );
    const view = within(rendered.container);

    await userEvent.click(view.getByText("Create an examination"));
    await userEvent.type(view.getByLabelText("Examination name"), "Operating systems oral");
    await userEvent.type(view.getByLabelText("Subject"), "Computer science");
    await userEvent.type(view.getByLabelText("Question 1"), "Explain virtual memory.");
    await userEvent.click(view.getByRole("button", { name: "+ Add question" }));
    await userEvent.type(view.getByLabelText("Question 2"), "What causes deadlock?");
    await userEvent.click(view.getByRole("button", { name: "Create examination" }));

    expect(conversationApi.createExamination).toHaveBeenCalledWith({
      name: "Operating systems oral",
      subject: "Computer science",
      questions: ["Explain virtual memory.", "What causes deadlock?"],
    });
    expect(await view.findByText("Operating systems oral")).toBeVisible();
  });

  it("shows the completed post-conversation state", async () => {
    render(<PostConversationPage conversationId={ID} api={api()} navigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Examination complete" })).toBeVisible();
    expect(screen.getByText("Your recording has been saved for review.")).toBeVisible();
  });

  it("ends an active call and navigates to the post-conversation page", async () => {
    const navigate = vi.fn();
    const starting = {
      ...state(ConversationStateTag.Starting),
      transport: { status: "connecting" as const, epoch: 1 },
      artifact: { status: "pending" as const },
      starting: { startDeadlineAt: 10_000 },
    };
    const ending = {
      ...starting,
      state: ConversationStateTag.Ending,
      revision: 2,
      ending: { target: "complete" as const },
    } as ConversationStateDto;
    const runtime: ConversationRuntime = {
      connect: vi.fn().mockResolvedValue(ok(undefined)),
      enableAudio: vi.fn().mockResolvedValue(ok(undefined)),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(ok(undefined)),
      requestEnd: vi.fn().mockResolvedValue(ok(ending)),
      close: vi.fn().mockResolvedValue(ok(undefined)),
    };
    const runtimeFactory: RuntimeFactory = vi.fn().mockReturnValue(runtime);
    const conversationApi = api({
      getState: vi.fn().mockResolvedValue(ok(state(ConversationStateTag.Created))),
      startConversation: vi.fn().mockResolvedValue(ok(starting)),
    });

    render(
      <ConversationPage
        conversationId={ID}
        api={conversationApi}
        runtimeFactory={runtimeFactory}
        navigate={navigate}
      />,
    );
    const endButton = await screen.findByRole("button", { name: "End" });
    await userEvent.click(endButton);

    expect(runtime.requestEnd).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(`/conversation/${ID}/complete`);
  });

  it("labels connecting, connected, live, reconnecting, and ending snapshots", async () => {
    const starting = {
      ...state(ConversationStateTag.Starting),
      transport: { status: "connecting" as const, epoch: 1 },
      artifact: { status: "pending" as const },
      starting: { startDeadlineAt: 10_000 },
    } as ConversationStateDto;
    let events: RuntimeEvents | null = null;
    const runtime: ConversationRuntime = {
      connect: vi.fn().mockResolvedValue(ok(undefined)),
      enableAudio: vi.fn().mockResolvedValue(ok(undefined)),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(ok(undefined)),
      requestEnd: vi.fn(),
      close: vi.fn().mockResolvedValue(ok(undefined)),
    };
    const runtimeFactory: RuntimeFactory = vi.fn((_api, _conversationId, nextEvents) => {
      events = nextEvents;
      return runtime;
    });
    render(
      <ConversationPage
        conversationId={ID}
        api={api({
          getState: vi.fn().mockResolvedValue(ok(starting)),
          startConversation: vi.fn().mockResolvedValue(ok(starting)),
        })}
        runtimeFactory={runtimeFactory}
        navigate={vi.fn()}
      />,
    );

    expect(await screen.findByText("Connecting")).toBeVisible();
    expect(events).not.toBeNull();
    act(() =>
      events!.onState({
        ...starting,
        revision: 2,
        transport: { status: TransportStatus.Connected, epoch: 1 },
      }),
    );
    expect(screen.getByText("Connected · Starting recording")).toBeVisible();

    const live = {
      ...starting,
      state: ConversationStateTag.Live,
      revision: 3,
      transport: { status: TransportStatus.Connected, epoch: 1 },
      artifact: { status: "recording" as const },
      live: { startedAt: 2, maximumEndAt: 60_002 },
    } as ConversationStateDto;
    act(() => events!.onState(live));
    expect(screen.getByText("Live · Recording")).toBeVisible();

    act(() =>
      events!.onState({
        ...live,
        revision: 4,
        transport: {
          status: TransportStatus.Reconnecting,
          epoch: 1,
          attempt: 1,
          lastErrorCode: "transport.livekit_media_interrupted",
        },
      }),
    );
    expect(screen.getByText("Reconnecting")).toBeVisible();

    act(() =>
      events!.onState({
        ...live,
        state: ConversationStateTag.Ending,
        revision: 5,
        transport: { status: "closed", epoch: 1 },
        ending: { target: "complete" },
      } as ConversationStateDto),
    );
    expect(screen.getByText("Finalizing recording")).toBeVisible();
  });
});
