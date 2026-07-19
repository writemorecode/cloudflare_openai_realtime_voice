/** Implements the browser-facing HTTP client for authenticated conversation API operations. */
import type { ConversationStateDto } from "../../src/worker/http/conversation-state-dto";
import { WIRE_SUBPROTOCOL } from "../../src/shared/protocol/conversation-wire";
import type { AuthSession, ConversationApi, LiveKitAccess } from "./types";

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
    return this.request("/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  }

  getSession(): Promise<AuthSession> {
    return this.request("/v1/auth/session");
  }

  async logout(): Promise<void> {
    await this.request("/v1/auth/logout", { method: "POST", expectJson: false });
  }

  createConversation(): Promise<ConversationStateDto> {
    return this.request("/v1/conversations", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
  }

  startConversation(conversationId: string): Promise<ConversationStateDto> {
    return this.request(`/v1/conversations/${conversationId}/start`, { method: "POST" });
  }

  getState(conversationId: string): Promise<ConversationStateDto> {
    return this.request(`/v1/conversations/${conversationId}/state`);
  }

  getLiveKitAccess(conversationId: string): Promise<LiveKitAccess> {
    return this.request(`/v1/conversations/${conversationId}/livekit-access`, { method: "POST" });
  }

  async releaseLiveKitAccess(conversationId: string): Promise<void> {
    await this.request(`/v1/conversations/${conversationId}/livekit-access`, {
      method: "DELETE",
      expectJson: false,
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

  private async request<T>(
    path: string,
    init: RequestInit & { readonly expectJson?: boolean } = {},
  ): Promise<T> {
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
    if (init.expectJson === false) return undefined as T;
    return (await response.json()) as T;
  }
}
