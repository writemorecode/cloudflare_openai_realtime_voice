/** Verifies browser-page authentication, navigation, and live-conversation controls. */
import { act, render, screen } from "@testing-library/react";
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
import { ConversationPage, HomePage, PostConversationPage } from "./App";

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
  it("starts on the home page and navigates to the created conversation", async () => {
    const navigate = vi.fn();
    render(<HomePage api={api()} navigate={navigate} />);
    await userEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    expect(navigate).toHaveBeenCalledWith(`/conversation/${ID}`);
  });

  it("requires and submits username and password credentials", async () => {
    const navigate = vi.fn();
    const authenticateAndCreate = vi
      .fn()
      .mockResolvedValue(ok(state(ConversationStateTag.Created)));
    render(
      <HomePage api={null} authenticateAndCreate={authenticateAndCreate} navigate={navigate} />,
    );

    const usernameInput = screen.getByLabelText("Sign in");
    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter your username and password to continue.",
    );
    expect(authenticateAndCreate).not.toHaveBeenCalled();

    await userEvent.type(usernameInput, "examiner");
    await userEvent.type(passwordInput, "correct horse battery staple");
    await userEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    expect(authenticateAndCreate).toHaveBeenCalledWith("examiner", "correct horse battery staple");
    expect(navigate).toHaveBeenCalledWith(`/conversation/${ID}`);
  });

  it("shows the completed post-conversation state", async () => {
    render(<PostConversationPage conversationId={ID} api={api()} navigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Conversation complete" })).toBeVisible();
    expect(
      screen.getByText("Your recording has been saved and is ready for the next step."),
    ).toBeVisible();
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
