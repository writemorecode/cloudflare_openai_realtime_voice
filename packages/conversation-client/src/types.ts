/** Defines the browser application's API, media-runtime, and event contracts. */
import type {
  AuthSession,
  ConversationStateDto,
  LiveKitAccess,
} from "@ai-oral-exam/conversation-contract";
import type { Result } from "@ai-oral-exam/result";
import type { ConversationClientError } from "./errors";

export interface ConversationApi {
  login(username: string, password: string): Promise<Result<AuthSession, ConversationClientError>>;
  getSession(): Promise<Result<AuthSession, ConversationClientError>>;
  logout(): Promise<Result<void, ConversationClientError>>;
  createConversation(): Promise<Result<ConversationStateDto, ConversationClientError>>;
  startConversation(
    conversationId: string,
  ): Promise<Result<ConversationStateDto, ConversationClientError>>;
  getState(conversationId: string): Promise<Result<ConversationStateDto, ConversationClientError>>;
  getLiveKitAccess(conversationId: string): Promise<Result<LiveKitAccess, ConversationClientError>>;
  releaseLiveKitAccess(conversationId: string): Promise<Result<void, ConversationClientError>>;
  websocketUrl(conversationId: string): string;
  websocketProtocols(): string[];
}

export interface RuntimeEvents {
  readonly onState: (state: ConversationStateDto) => void;
  readonly onPlaybackBlocked: (blocked: boolean) => void;
}

export interface ConversationRuntime {
  connect(
    initialState: ConversationStateDto,
    audioHost: HTMLElement,
  ): Promise<Result<void, ConversationClientError>>;
  enableAudio(): Promise<Result<void, ConversationClientError>>;
  setMicrophoneEnabled(enabled: boolean): Promise<Result<void, ConversationClientError>>;
  requestEnd(): Promise<Result<ConversationStateDto, ConversationClientError>>;
  close(): Promise<Result<void, ConversationClientError>>;
}

export type RuntimeFactory = (
  api: ConversationApi,
  conversationId: string,
  events: RuntimeEvents,
) => ConversationRuntime;
