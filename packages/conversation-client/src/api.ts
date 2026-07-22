/** Implements the browser-facing HTTP client for authenticated conversation API operations. */
import {
  WIRE_SUBPROTOCOL,
  authSessionSchema,
  conversationStateSchema,
  liveKitAccessSchema,
  type AuthSession,
  type ConversationStateDto,
  type LiveKitAccess,
} from "@ai-oral-exam/conversation-contract";
import type { z } from "zod";
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

  login(username: string, password: string): Promise<AuthSession> {
    return this.request("/v1/auth/login", authSessionSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  }

  getSession(): Promise<AuthSession> {
    return this.request("/v1/auth/session", authSessionSchema);
  }

  async logout(): Promise<void> {
    await this.requestWithoutResponse("/v1/auth/logout", { method: "POST" });
  }

  createConversation(): Promise<ConversationStateDto> {
    return this.request("/v1/conversations", conversationStateSchema, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
  }

  startConversation(conversationId: string): Promise<ConversationStateDto> {
    return this.request(`/v1/conversations/${conversationId}/start`, conversationStateSchema, {
      method: "POST",
    });
  }

  getState(conversationId: string): Promise<ConversationStateDto> {
    return this.request(`/v1/conversations/${conversationId}/state`, conversationStateSchema);
  }

  getLiveKitAccess(conversationId: string): Promise<LiveKitAccess> {
    return this.request(`/v1/conversations/${conversationId}/livekit-access`, liveKitAccessSchema, {
      method: "POST",
    });
  }

  async releaseLiveKitAccess(conversationId: string): Promise<void> {
    await this.requestWithoutResponse(`/v1/conversations/${conversationId}/livekit-access`, {
      method: "DELETE",
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
  ): Promise<z.infer<T>> {
    const response = await this.fetchResponse(path, init);
    return schema.parse(await response.json());
  }

  private async requestWithoutResponse(path: string, init: RequestInit): Promise<void> {
    await this.fetchResponse(path, init);
  }

  private async fetchResponse(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    const response = await fetch(new URL(path, this.config.baseUrl), {
      ...init,
      credentials: "same-origin",
      headers,
    });
    if (!response.ok) {
      let details: ProblemDetails = {};
      try {
        details = (await response.json()) as ProblemDetails;
      } catch {
        // The HTTP status remains useful if the response has no JSON problem body.
      }
      throw new Error(details.detail ?? details.title ?? `Request failed (${response.status})`);
    }
    return response;
  }
}
