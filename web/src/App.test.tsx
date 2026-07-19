/** Verifies browser-page authentication, navigation, and live-conversation controls. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConversationStateDto } from "../../src/worker/http/conversation-state-dto";
import { ConversationStateTag } from "../../src/domain/conversation-state-machine";
import { ConversationPage, HomePage, PostConversationPage } from "./App";
import type { ConversationApi, ConversationRuntime, RuntimeFactory } from "./types";

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
    login: vi.fn().mockResolvedValue({ username: "examiner" }),
    getSession: vi.fn().mockResolvedValue({ username: "examiner" }),
    logout: vi.fn(),
    createConversation: vi.fn().mockResolvedValue(state(ConversationStateTag.Created)),
    startConversation: vi.fn(),
    getState: vi.fn().mockResolvedValue(state(ConversationStateTag.Completed)),
    getLiveKitAccess: vi.fn(),
    releaseLiveKitAccess: vi.fn(),
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
    const authenticateAndCreate = vi.fn().mockResolvedValue(state(ConversationStateTag.Created));
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
      connect: vi.fn().mockResolvedValue(undefined),
      enableAudio: vi.fn().mockResolvedValue(undefined),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      requestEnd: vi.fn().mockResolvedValue(ending),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const runtimeFactory: RuntimeFactory = vi.fn().mockReturnValue(runtime);
    const conversationApi = api({
      getState: vi.fn().mockResolvedValue(state(ConversationStateTag.Created)),
      startConversation: vi.fn().mockResolvedValue(starting),
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
});
