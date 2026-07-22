/** Defines the browser application's API, media-runtime, and event contracts. */
import type {
  AuthSession,
  ConversationStateDto,
  LiveKitAccess,
} from "@ai-oral-exam/conversation-contract";

export interface ConversationApi {
  login(username: string, password: string): Promise<AuthSession>;
  getSession(): Promise<AuthSession>;
  logout(): Promise<void>;
  createConversation(): Promise<ConversationStateDto>;
  startConversation(conversationId: string): Promise<ConversationStateDto>;
  getState(conversationId: string): Promise<ConversationStateDto>;
  getLiveKitAccess(conversationId: string): Promise<LiveKitAccess>;
  releaseLiveKitAccess(conversationId: string): Promise<void>;
  websocketUrl(conversationId: string): string;
  websocketProtocols(): string[];
}

export interface RuntimeEvents {
  readonly onState: (state: ConversationStateDto) => void;
  readonly onPlaybackBlocked: (blocked: boolean) => void;
}

export interface ConversationRuntime {
  connect(initialState: ConversationStateDto, audioHost: HTMLElement): Promise<void>;
  enableAudio(): Promise<void>;
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  requestEnd(): Promise<ConversationStateDto>;
  close(): Promise<void>;
}

export type RuntimeFactory = (
  api: ConversationApi,
  conversationId: string,
  events: RuntimeEvents,
) => ConversationRuntime;
