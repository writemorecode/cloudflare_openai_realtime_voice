/** Defines the browser application's API, media-runtime, and event contracts. */
import type {
  AuthSession,
  CreateExaminationRequest,
  ConversationStateDto,
  Examination,
  ExaminationList,
  ExaminationSession,
  ExaminationSessionList,
  Transcript,
  RecordingUpload,
  UploadedRecordingPart,
} from "@ai-oral-exam/conversation-contract";
import type { Result } from "better-result";
import type { ConversationClientError } from "./errors";

/** HTTP and WebSocket operations required by a browser conversation runtime. */
export interface ConversationApi {
  /** Authenticates a user and returns the resulting session. */
  login(username: string, password: string): Promise<Result<AuthSession, ConversationClientError>>;
  /** Returns the current authenticated session. */
  getSession(): Promise<Result<AuthSession, ConversationClientError>>;
  /** Ends the current authenticated session. */
  logout(): Promise<Result<void, ConversationClientError>>;
  /** Creates an examination. */
  createExamination(
    examination: CreateExaminationRequest,
  ): Promise<Result<Examination, ConversationClientError>>;
  /** Lists available examinations. */
  listExaminations(): Promise<Result<ExaminationList, ConversationClientError>>;
  /** Retrieves an examination by identifier. */
  getExamination(examinationId: string): Promise<Result<Examination, ConversationClientError>>;
  /** Creates an examination session. */
  createExaminationSession(
    examinationId: string,
  ): Promise<Result<ExaminationSession, ConversationClientError>>;
  /** Lists available examination sessions. */
  listExaminationSessions(): Promise<Result<ExaminationSessionList, ConversationClientError>>;
  /** Retrieves an examination session by identifier. */
  getExaminationSession(
    examinationSessionId: string,
  ): Promise<Result<ExaminationSession, ConversationClientError>>;
  /** Returns the absolute URL for an examination session's recording. */
  recordingUrl(examinationSessionId: string): string;
  /** Retrieves the validated transcript for an examination session. */
  getExaminationSessionTranscript(
    examinationSessionId: string,
  ): Promise<Result<Transcript, ConversationClientError>>;
  /** Creates a conversation. */
  createConversation(): Promise<Result<ConversationStateDto, ConversationClientError>>;
  /** Starts a conversation. */
  startConversation(
    conversationId: string,
  ): Promise<Result<ConversationStateDto, ConversationClientError>>;
  /** Retrieves the latest conversation state. */
  getState(conversationId: string): Promise<Result<ConversationStateDto, ConversationClientError>>;
  /** Exchanges a WebRTC SDP offer for a Realtime SDP answer. */
  createRealtimeCall(
    conversationId: string,
    sdp: string,
  ): Promise<Result<string, ConversationClientError>>;
  /** Executes a Realtime-requested server-side tool. */
  executeRealtimeTool(
    conversationId: string,
    name: string,
    argumentsJson: string,
  ): Promise<Result<unknown, ConversationClientError>>;
  /** Allocates multipart-upload metadata for a recording. */
  beginRecording(
    conversationId: string,
    contentType: string,
  ): Promise<Result<RecordingUpload, ConversationClientError>>;
  /** Marks a multipart recording upload as started. */
  beginRecordingUpload(
    conversationId: string,
    upload: RecordingUpload,
  ): Promise<Result<void, ConversationClientError>>;
  /** Uploads one numbered recording part. */
  uploadRecordingPart(
    conversationId: string,
    upload: RecordingUpload,
    partNumber: number,
    body: Blob,
  ): Promise<Result<UploadedRecordingPart, ConversationClientError>>;
  /** Completes the recording upload and returns the new conversation state. */
  completeRecordingUpload(
    conversationId: string,
    upload: RecordingUpload,
    parts: readonly UploadedRecordingPart[],
  ): Promise<Result<ConversationStateDto, ConversationClientError>>;
  /** Aborts an incomplete recording upload. */
  abortRecordingUpload(
    conversationId: string,
    upload: RecordingUpload,
  ): Promise<Result<void, ConversationClientError>>;
  /** Returns the control-WebSocket URL for a conversation. */
  websocketUrl(conversationId: string): string;
  /** Returns the WebSocket subprotocols required by the control connection. */
  websocketProtocols(): string[];
}

/** Event callbacks emitted by a running browser conversation. */
export interface RuntimeEvents {
  /** Receives each accepted conversation-state snapshot. */
  readonly onState: (state: ConversationStateDto) => void;
  /** Reports whether browser autoplay restrictions are blocking examiner audio. */
  readonly onPlaybackBlocked: (blocked: boolean) => void;
}

/** Controls the browser media and Realtime resources for one conversation. */
export interface ConversationRuntime {
  /** Connects browser media and control transports using an initial state snapshot. */
  connect(
    initialState: ConversationStateDto,
    audioHost: HTMLElement,
  ): Promise<Result<void, ConversationClientError>>;
  /** Attempts to start remote-audio playback after a browser user gesture. */
  enableAudio(): Promise<Result<void, ConversationClientError>>;
  /** Enables or disables the captured microphone track. */
  setMicrophoneEnabled(enabled: boolean): Promise<Result<void, ConversationClientError>>;
  /** Requests conversation shutdown and finalizes its recording. */
  requestEnd(): Promise<Result<ConversationStateDto, ConversationClientError>>;
  /** Closes transports and releases media resources. */
  close(): Promise<Result<void, ConversationClientError>>;
}

/** Creates an independently managed runtime for a conversation. */
export type RuntimeFactory = (
  api: ConversationApi,
  conversationId: string,
  events: RuntimeEvents,
) => ConversationRuntime;
