/** Implements the browser-facing HTTP client for authenticated conversation API operations. */
import {
  WIRE_SUBPROTOCOL,
  authSessionSchema,
  examinationListSchema,
  examinationSchema,
  examinationSessionListSchema,
  examinationSessionSchema,
  transcriptSchema,
  conversationStateSchema,
  recordingUploadSchema,
  uploadedRecordingPartSchema,
  type CreateExaminationRequest,
  type Examination,
  type ExaminationList,
  type ExaminationSession,
  type ExaminationSessionList,
  type Transcript,
  type AuthSession,
  type ConversationStateDto,
  type RecordingUpload,
  type UploadedRecordingPart,
} from "@ai-oral-exam/conversation-contract";
import { Result } from "better-result";
import { z } from "zod";
import { ConversationClientError, conversationClientError } from "./errors";
import type { ConversationApi } from "./types";

/** Relevant fields extracted from an RFC 7807-style HTTP problem response. */
interface ProblemDetails {
  /** Human-readable explanation of the specific request failure. */
  detail?: string;
  /** Short summary of the request failure. */
  title?: string;
}

const optionalApiBaseUrlSchema = z.string().optional();
const problemDetailsSchema = z.object({
  detail: z.string().optional(),
  title: z.string().optional(),
});

/** Configuration required to reach the conversation HTTP API from a browser. */
export interface BrowserApiConfig {
  /** Absolute origin used to resolve relative API paths. */
  readonly baseUrl: string;
}

/** Creates browser API configuration from the build-time API URL or current origin. */
export function browserApiConfig(): BrowserApiConfig {
  const configuredBaseUrl = optionalApiBaseUrlSchema.safeParse(import.meta.env.VITE_API_BASE_URL);
  return {
    baseUrl: configuredBaseUrl.success
      ? (configuredBaseUrl.data ?? window.location.origin)
      : window.location.origin,
  };
}

/** Browser implementation of the authenticated conversation HTTP API. */
export class HttpConversationApi implements ConversationApi {
  /** Creates an API client using the supplied browser endpoint configuration. */
  constructor(private readonly config: BrowserApiConfig = browserApiConfig()) {}

  /** Authenticates a user and returns the resulting browser session. */
  login(username: string, password: string): Promise<Result<AuthSession, ConversationClientError>> {
    return this.request("/v1/auth/login", authSessionSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  }

  /** Returns the active authenticated session, if one exists. */
  getSession(): Promise<Result<AuthSession, ConversationClientError>> {
    return this.request("/v1/auth/session", authSessionSchema);
  }

  /** Ends the active authenticated session. */
  logout(): Promise<Result<void, ConversationClientError>> {
    return this.requestWithoutResponse("/v1/auth/logout", { method: "POST" });
  }

  /** Creates an examination from the supplied name, subject, and questions. */
  createExamination(
    examination: CreateExaminationRequest,
  ): Promise<Result<Examination, ConversationClientError>> {
    return this.request("/v1/examinations", examinationSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(examination),
    });
  }

  /** Lists the examinations visible to the current user. */
  listExaminations(): Promise<Result<ExaminationList, ConversationClientError>> {
    return this.request("/v1/examinations", examinationListSchema);
  }

  /** Retrieves one examination by identifier. */
  getExamination(examinationId: string): Promise<Result<Examination, ConversationClientError>> {
    return this.request(`/v1/examinations/${examinationId}`, examinationSchema);
  }

  /** Creates a new session for the specified examination. */
  createExaminationSession(
    examinationId: string,
  ): Promise<Result<ExaminationSession, ConversationClientError>> {
    return this.request(`/v1/examinations/${examinationId}/sessions`, examinationSessionSchema, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
  }

  /** Lists examination sessions visible to the current user. */
  listExaminationSessions(): Promise<Result<ExaminationSessionList, ConversationClientError>> {
    return this.request("/v1/examination-sessions", examinationSessionListSchema);
  }

  /** Retrieves one examination session by identifier. */
  getExaminationSession(
    examinationSessionId: string,
  ): Promise<Result<ExaminationSession, ConversationClientError>> {
    return this.request(
      `/v1/examination-sessions/${examinationSessionId}`,
      examinationSessionSchema,
    );
  }

  /** Returns the absolute URL for an examination session's recording. */
  recordingUrl(examinationSessionId: string): string {
    const encodedSessionId = encodeURIComponent(examinationSessionId);
    const url = new URL(
      `/v1/examination-sessions/${encodedSessionId}/recording`,
      this.config.baseUrl,
    );
    return url.href;
  }

  /** Retrieves one examination session transcript. */
  getExaminationSessionTranscript(
    examinationSessionId: string,
  ): Promise<Result<Transcript, ConversationClientError>> {
    return this.request(
      `/v1/examination-sessions/${encodeURIComponent(examinationSessionId)}/transcript`,
      transcriptSchema,
    );
  }

  /** Creates a conversation and returns its initial state. */
  createConversation(): Promise<Result<ConversationStateDto, ConversationClientError>> {
    return this.request("/v1/conversations", conversationStateSchema, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
  }

  /** Starts a conversation and returns its updated state. */
  startConversation(
    conversationId: string,
  ): Promise<Result<ConversationStateDto, ConversationClientError>> {
    return this.request(`/v1/conversations/${conversationId}/start`, conversationStateSchema, {
      method: "POST",
    });
  }

  /** Retrieves the latest state snapshot for a conversation. */
  getState(conversationId: string): Promise<Result<ConversationStateDto, ConversationClientError>> {
    return this.request(`/v1/conversations/${conversationId}/state`, conversationStateSchema);
  }

  /** Exchanges a WebRTC SDP offer for the Realtime service's SDP answer. */
  async createRealtimeCall(
    conversationId: string,
    sdp: string,
  ): Promise<Result<string, ConversationClientError>> {
    const response = await this.fetchResponse(`/v1/conversations/${conversationId}/realtime-call`, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: sdp,
    });
    if (!response.isOk()) return response;
    return Result.tryPromise({
      try: () => response.value.text(),
      catch: (cause) =>
        conversationClientError("invalid_response", "The Realtime answer was unreadable.", cause),
    });
  }

  /** Invokes a server-side tool requested through the Realtime data channel. */
  async executeRealtimeTool(
    conversationId: string,
    name: string,
    argumentsJson: string,
  ): Promise<Result<unknown, ConversationClientError>> {
    const path = `/v1/conversations/${conversationId}/tools/${encodeURIComponent(name)}`;
    const isGetter = name === "get_current_examination_question";
    const init: RequestInit = isGetter
      ? { method: "POST" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: argumentsJson,
        };
    const response = await this.fetchResponse(path, init);
    if (!response.isOk()) return response;
    return Result.tryPromise({
      try: () => response.value.json(),
      catch: (cause) =>
        conversationClientError("invalid_response", "The tool response was unreadable.", cause),
    });
  }

  /** Allocates multipart-upload metadata for a conversation recording. */
  beginRecording(
    conversationId: string,
    contentType: string,
  ): Promise<Result<RecordingUpload, ConversationClientError>> {
    return this.request(`/v1/conversations/${conversationId}/recording`, recordingUploadSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType }),
    });
  }

  /** Marks a recording upload as started before parts are transferred. */
  beginRecordingUpload(
    conversationId: string,
    upload: RecordingUpload,
  ): Promise<Result<void, ConversationClientError>> {
    return this.requestWithoutResponse(`/v1/conversations/${conversationId}/recording/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId: upload.uploadId, objectKey: upload.objectKey }),
    });
  }

  /** Uploads one numbered recording part. */
  uploadRecordingPart(
    conversationId: string,
    upload: RecordingUpload,
    partNumber: number,
    body: Blob,
  ): Promise<Result<UploadedRecordingPart, ConversationClientError>> {
    const query = new URLSearchParams({ uploadId: upload.uploadId, objectKey: upload.objectKey });
    return this.request(
      `/v1/conversations/${conversationId}/recording/parts/${partNumber}?${query}`,
      uploadedRecordingPartSchema,
      { method: "PUT", body },
    );
  }

  /** Completes a multipart recording upload and refreshes the conversation state. */
  async completeRecordingUpload(
    conversationId: string,
    upload: RecordingUpload,
    parts: readonly UploadedRecordingPart[],
  ): Promise<Result<ConversationStateDto, ConversationClientError>> {
    const response = await this.fetchResponse(
      `/v1/conversations/${conversationId}/recording/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: upload.uploadId, objectKey: upload.objectKey, parts }),
      },
    );
    if (!response.isOk()) return response;
    const refreshed = await this.getState(conversationId);
    return refreshed;
  }

  /** Aborts a recording upload that will not be completed. */
  abortRecordingUpload(
    conversationId: string,
    upload: RecordingUpload,
  ): Promise<Result<void, ConversationClientError>> {
    return this.requestWithoutResponse(`/v1/conversations/${conversationId}/recording`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId: upload.uploadId, objectKey: upload.objectKey }),
    });
  }

  /** Returns the WebSocket endpoint for a conversation's control connection. */
  websocketUrl(conversationId: string): string {
    const url = new URL(`/v1/conversations/${conversationId}/connect`, this.config.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  /** Returns the WebSocket subprotocols required by the control connection. */
  websocketProtocols(): string[] {
    return [WIRE_SUBPROTOCOL];
  }

  /** Sends an HTTP request and validates its JSON response against the supplied schema. */
  private async request<T extends z.ZodType>(
    path: string,
    schema: T,
    init: RequestInit = {},
  ): Promise<Result<z.infer<T>, ConversationClientError>> {
    const response = await this.fetchResponse(path, init);
    if (!response.isOk()) return Result.err(response.error);
    const body = await Result.tryPromise({
      try: () => response.value.json(),
      catch: (cause) =>
        conversationClientError(
          "invalid_response",
          "The server returned an unreadable response.",
          cause,
        ),
    });
    if (!body.isOk()) return Result.err(body.error);
    const parsed = schema.safeParse(body.value);
    return parsed.success
      ? Result.ok(parsed.data)
      : Result.err(
          new ConversationClientError(
            "invalid_response",
            "The server returned an invalid response.",
            parsed.error,
          ),
        );
  }

  /** Sends an HTTP request whose successful response has no body. */
  private async requestWithoutResponse(
    path: string,
    init: RequestInit,
  ): Promise<Result<void, ConversationClientError>> {
    const response = await this.fetchResponse(path, init);
    return response.isOk() ? Result.ok(undefined) : Result.err(response.error);
  }

  /** Performs an authenticated same-origin fetch and normalizes failures. */
  private async fetchResponse(
    path: string,
    init: RequestInit,
  ): Promise<Result<Response, ConversationClientError>> {
    const responseResult = await Result.tryPromise({
      try: () => {
        const headers = new Headers(init.headers);
        const url = new URL(path, this.config.baseUrl);
        return fetch(url, {
          ...init,
          credentials: "same-origin",
          headers,
        });
      },
      catch: (cause) =>
        conversationClientError("request_failed", "The request could not be completed.", cause),
    });
    if (!responseResult.isOk()) return Result.err(responseResult.error);
    const response = responseResult.value;
    if (!response.ok) {
      const details = await Result.tryPromise({
        try: () => response.json(),
        catch: () => null,
      });
      const problem = details.isOk() ? problemDetails(details.value) : {};
      return Result.err(
        new ConversationClientError(
          "http_request_failed",
          problem.detail ?? problem.title ?? `Request failed (${response.status})`,
        ),
      );
    }
    return Result.ok(response);
  }
}

/** Extracts displayable title and detail fields from an untrusted problem response. */
function problemDetails<T>(value: T): ProblemDetails {
  const parsed = problemDetailsSchema.safeParse(value);
  if (!parsed.success) return {};
  const problem: ProblemDetails = {};
  if (parsed.data.detail !== undefined) problem.detail = parsed.data.detail;
  if (parsed.data.title !== undefined) problem.title = parsed.data.title;
  return problem;
}
