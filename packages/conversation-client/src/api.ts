/** Implements the browser-facing HTTP client for authenticated conversation API operations. */
import {
  WIRE_SUBPROTOCOL,
  authSessionSchema,
  examinationListSchema,
  examinationSchema,
  examinationSessionListSchema,
  examinationSessionSchema,
  conversationStateSchema,
  recordingUploadSchema,
  uploadedRecordingPartSchema,
  type CreateExaminationRequest,
  type Examination,
  type ExaminationList,
  type ExaminationSession,
  type ExaminationSessionList,
  type AuthSession,
  type ConversationStateDto,
  type RecordingUpload,
  type UploadedRecordingPart,
} from "@ai-oral-exam/conversation-contract";
import { Result } from "better-result";
import type { z } from "zod";
import { ConversationClientError, conversationClientError } from "./errors";
import type { ConversationApi } from "./types";

interface ProblemDetails {
  readonly detail?: string;
  readonly title?: string;
}

export interface BrowserApiConfig {
  readonly baseUrl: string;
}

export function browserApiConfig(): BrowserApiConfig {
  return {
    baseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
  };
}

export class HttpConversationApi implements ConversationApi {
  constructor(private readonly config: BrowserApiConfig = browserApiConfig()) {}

  login(username: string, password: string): Promise<Result<AuthSession, ConversationClientError>> {
    return this.request("/v1/auth/login", authSessionSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  }

  getSession(): Promise<Result<AuthSession, ConversationClientError>> {
    return this.request("/v1/auth/session", authSessionSchema);
  }

  logout(): Promise<Result<void, ConversationClientError>> {
    return this.requestWithoutResponse("/v1/auth/logout", { method: "POST" });
  }

  createExamination(
    examination: CreateExaminationRequest,
  ): Promise<Result<Examination, ConversationClientError>> {
    return this.request("/v1/examinations", examinationSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(examination),
    });
  }

  listExaminations(): Promise<Result<ExaminationList, ConversationClientError>> {
    return this.request("/v1/examinations", examinationListSchema);
  }

  getExamination(examinationId: string): Promise<Result<Examination, ConversationClientError>> {
    return this.request(`/v1/examinations/${examinationId}`, examinationSchema);
  }

  createExaminationSession(
    examinationId: string,
  ): Promise<Result<ExaminationSession, ConversationClientError>> {
    return this.request(`/v1/examinations/${examinationId}/sessions`, examinationSessionSchema, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
  }

  listExaminationSessions(): Promise<Result<ExaminationSessionList, ConversationClientError>> {
    return this.request("/v1/examination-sessions", examinationSessionListSchema);
  }

  getExaminationSession(
    examinationSessionId: string,
  ): Promise<Result<ExaminationSession, ConversationClientError>> {
    return this.request(
      `/v1/examination-sessions/${examinationSessionId}`,
      examinationSessionSchema,
    );
  }

  recordingUrl(examinationSessionId: string): string {
    const encodedSessionId = encodeURIComponent(examinationSessionId);
    const url = new URL(
      `/v1/examination-sessions/${encodedSessionId}/recording`,
      this.config.baseUrl,
    );
    return url.href;
  }

  createConversation(): Promise<Result<ConversationStateDto, ConversationClientError>> {
    return this.request("/v1/conversations", conversationStateSchema, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
  }

  startConversation(
    conversationId: string,
  ): Promise<Result<ConversationStateDto, ConversationClientError>> {
    return this.request(`/v1/conversations/${conversationId}/start`, conversationStateSchema, {
      method: "POST",
    });
  }

  getState(conversationId: string): Promise<Result<ConversationStateDto, ConversationClientError>> {
    return this.request(`/v1/conversations/${conversationId}/state`, conversationStateSchema);
  }

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

  websocketUrl(conversationId: string): string {
    const url = new URL(`/v1/conversations/${conversationId}/connect`, this.config.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  websocketProtocols(): string[] {
    return [WIRE_SUBPROTOCOL];
  }

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

  private async requestWithoutResponse(
    path: string,
    init: RequestInit,
  ): Promise<Result<void, ConversationClientError>> {
    const response = await this.fetchResponse(path, init);
    return response.isOk() ? Result.ok(undefined) : Result.err(response.error);
  }

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
        try: () => response.json() as Promise<unknown>,
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

function problemDetails(value: unknown): ProblemDetails {
  if (typeof value !== "object" || value === null) return {};
  const detail = "detail" in value && typeof value.detail === "string" ? value.detail : undefined;
  const title = "title" in value && typeof value.title === "string" ? value.title : undefined;
  return {
    ...(detail === undefined ? {} : { detail }),
    ...(title === undefined ? {} : { title }),
  };
}
