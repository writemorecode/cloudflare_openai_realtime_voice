/** Defines the browser application's API, media-runtime, and event contracts. */
import type {
  AuthSession,
  CreateExaminationRequest,
  ConversationStateDto,
  Examination,
  ExaminationList,
  ExaminationSession,
  ExaminationSessionList,
  RecordingUpload,
  UploadedRecordingPart,
} from "@ai-oral-exam/conversation-contract";
import type { Result } from "better-result";
import type { ConversationClientError } from "./errors";

export interface ConversationApi {
  login(username: string, password: string): Promise<Result<AuthSession, ConversationClientError>>;
  getSession(): Promise<Result<AuthSession, ConversationClientError>>;
  logout(): Promise<Result<void, ConversationClientError>>;
  createExamination(
    examination: CreateExaminationRequest,
  ): Promise<Result<Examination, ConversationClientError>>;
  listExaminations(): Promise<Result<ExaminationList, ConversationClientError>>;
  getExamination(examinationId: string): Promise<Result<Examination, ConversationClientError>>;
  createExaminationSession(
    examinationId: string,
  ): Promise<Result<ExaminationSession, ConversationClientError>>;
  listExaminationSessions(): Promise<Result<ExaminationSessionList, ConversationClientError>>;
  getExaminationSession(
    examinationSessionId: string,
  ): Promise<Result<ExaminationSession, ConversationClientError>>;
  recordingUrl(examinationSessionId: string): string;
  createConversation(): Promise<Result<ConversationStateDto, ConversationClientError>>;
  startConversation(
    conversationId: string,
  ): Promise<Result<ConversationStateDto, ConversationClientError>>;
  getState(conversationId: string): Promise<Result<ConversationStateDto, ConversationClientError>>;
  createRealtimeCall(
    conversationId: string,
    sdp: string,
  ): Promise<Result<string, ConversationClientError>>;
  executeRealtimeTool(
    conversationId: string,
    name: string,
    argumentsJson: string,
  ): Promise<Result<unknown, ConversationClientError>>;
  beginRecording(
    conversationId: string,
    contentType: string,
  ): Promise<Result<RecordingUpload, ConversationClientError>>;
  beginRecordingUpload(
    conversationId: string,
    upload: RecordingUpload,
  ): Promise<Result<void, ConversationClientError>>;
  uploadRecordingPart(
    conversationId: string,
    upload: RecordingUpload,
    partNumber: number,
    body: Blob,
  ): Promise<Result<UploadedRecordingPart, ConversationClientError>>;
  completeRecordingUpload(
    conversationId: string,
    upload: RecordingUpload,
    parts: readonly UploadedRecordingPart[],
  ): Promise<Result<ConversationStateDto, ConversationClientError>>;
  abortRecordingUpload(
    conversationId: string,
    upload: RecordingUpload,
  ): Promise<Result<void, ConversationClientError>>;
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
