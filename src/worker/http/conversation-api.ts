/** Stateless Cloudflare Worker HTTP router for application and provider integration requests. */
import {
  ConversationEventType,
  ConversationStateTag,
  value,
} from "../../domain/conversation-state-machine";
import type { ConversationSession } from "../../durable-object/conversation-session";
import { ApiError, problemResponse } from "./api-errors";
import { preflightResponse, validateOrigin, withCors } from "./api-cors";
import { deriveConversationId, validateIdempotencyKey } from "./api-security";
import { authenticateBrowserSession, login, logout, type AuthenticatedUser } from "./browser-auth";
import { toConversationStateDto, type ConversationStateDto } from "./conversation-state-dto";
import { WIRE_SUBPROTOCOL } from "../../shared/protocol/conversation-wire";
import { handleLiveKitWebhook } from "../integrations/livekit/webhook";
import { handleAgentEvent } from "../integrations/livekit/agent-events";
import {
  createLiveKitAccess,
  stopLiveKitAccess,
  type LiveKitAccessResponse,
} from "../integrations/livekit/access";

const STARTING_WINDOW_MS = 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const START_EVENT_PREFIX = "system:http:start:v1:";
const MAX_AUTHORIZATION_LENGTH = 512;
const MAX_CONTENT_TYPE_LENGTH = 128;
const MAX_WEBSOCKET_PROTOCOL_LENGTH = 1024;

type ApiRouteName =
  | "login"
  | "logout"
  | "auth_session"
  | "create_conversation"
  | "start_conversation"
  | "get_state"
  | "connect"
  | "livekit_access"
  | "livekit_agent_event"
  | "livekit_webhook";

interface MatchedRoute {
  readonly name: ApiRouteName;
  readonly allowedMethods: readonly string[];
  readonly conversationId: string | null;
}

interface RequestTelemetry {
  readonly kind: "conversation_http_request";
  readonly level: "info" | "error";
  readonly requestId: string;
  readonly method: string;
  readonly route: ApiRouteName | "unknown";
  readonly status: number;
  readonly durationMs: number;
  readonly conversationId: string | null;
  readonly resultingState: ConversationStateTag | null;
  readonly resultingRevision: number | null;
  readonly outcome: string;
}

interface RouteResult {
  readonly response: Response;
  readonly conversationId: string | null;
  readonly state: ConversationStateDto | null;
  readonly outcome: string;
}

export type StartConversationResponse = ConversationStateDto;

export const conversationApi = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    let route: MatchedRoute | null = null;
    let origin: string | null = null;
    let result: RouteResult | null = null;

    try {
      assertConfigured(env);
      origin = validateOrigin(request, env.ALLOWED_ORIGIN);
      route = matchRoute(url.pathname);

      if (request.method === "OPTIONS") {
        if (route === null) {
          throw new ApiError(404, "route_not_found", "The requested route does not exist.");
        }
        if (origin === null) {
          throw new ApiError(
            400,
            "origin_required",
            "CORS preflight requests require an Origin header.",
          );
        }
        const response = preflightResponse(origin, route.allowedMethods);
        result = {
          response,
          conversationId: route.conversationId,
          state: null,
          outcome: "preflight",
        };
      } else {
        if (route === null) {
          throw new ApiError(404, "route_not_found", "The requested route does not exist.");
        }
        if (!route.allowedMethods.includes(request.method)) {
          throw new ApiError(405, "method_not_allowed", "The request method is not allowed.", {
            Allow: route.allowedMethods.join(", "),
          });
        }
        if (route.name !== "livekit_webhook") validateSmallHeaders(request);
        if (route.name === "livekit_webhook") {
          // LiveKit authenticates this route with its signed webhook JWT.
        } else if (route.name === "livekit_agent_event") {
          // The integration handler verifies the agent-only bearer credential.
        } else if (route.name === "login") {
          requireBrowserOrigin(origin);
        } else {
          if (requiresSameOrigin(route, request)) requireBrowserOrigin(origin);
          await authenticateBrowserSession(request, env.AUTH_DB);
        }
        result = await dispatch(request, env, route);
      }
    } catch (error) {
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError(500, "internal_error", "The request could not be completed.");
      if (!(error instanceof ApiError)) {
        console.error(
          JSON.stringify({
            kind: "conversation_http_error",
            requestId,
            error: error instanceof Error ? error.name : "unknown_error",
          }),
        );
      }
      result = {
        response: problemResponse(apiError, requestId),
        conversationId: route?.conversationId ?? null,
        state: null,
        outcome: apiError.code,
      };
    }

    if (result.response.status === 101) {
      emitRequestTelemetry(request, route, result, 101, startedAt, requestId);
      return result.response;
    }
    const response = withRequestMetadata(withCors(result.response, origin), requestId);
    emitRequestTelemetry(request, route, result, response.status, startedAt, requestId);
    return response;
  },
} satisfies ExportedHandler<Env>;

function assertConfigured(env: Env): void {
  if (
    env.AGENT_CALLBACK_TOKEN.length === 0 ||
    env.CONVERSATION_ID_SECRET.length === 0 ||
    env.ALLOWED_ORIGIN.length === 0
  ) {
    throw new Error("Required API configuration is missing");
  }
}

async function dispatch(request: Request, env: Env, route: MatchedRoute): Promise<RouteResult> {
  switch (route.name) {
    case "login":
      return authResult(await login(request, env.AUTH_DB), "logged_in");
    case "logout":
      await assertNoBody(request);
      return authResult(await logout(request, env.AUTH_DB), "logged_out");
    case "auth_session": {
      await assertNoBody(request);
      const user = await authenticateBrowserSession(request, env.AUTH_DB);
      return authSessionResult(user);
    }
    case "create_conversation":
      await assertNoBody(request);
      return createConversation(request, env);
    case "start_conversation":
      await assertNoBody(request);
      return startConversation(env, requireConversationId(route));
    case "get_state":
      await assertNoBody(request);
      return getConversationState(env, requireConversationId(route));
    case "connect":
      await assertNoBody(request);
      return connectConversation(request, env, requireConversationId(route));
    case "livekit_access":
      await assertNoBody(request);
      return request.method === "DELETE"
        ? releaseLiveKitAccess(env, requireConversationId(route))
        : provideLiveKitAccess(env, requireConversationId(route));
    case "livekit_webhook":
      return receiveLiveKitWebhook(request, env);
    case "livekit_agent_event":
      return receiveLiveKitAgentEvent(request, env);
  }
}

async function releaseLiveKitAccess(env: Env, conversationId: string): Promise<RouteResult> {
  const outcome = await stopLiveKitAccess(env, conversationId);
  const state = await env.CONVERSATION_SESSIONS.getByName(conversationId).getState();
  if (state === null) {
    throw new ApiError(404, "conversation_not_found", "Conversation not found.");
  }
  return {
    response: new Response(null, { status: 204 }),
    conversationId,
    state: toConversationStateDto(state),
    outcome,
  };
}

async function receiveLiveKitAgentEvent(request: Request, env: Env): Promise<RouteResult> {
  const handled = await handleAgentEvent(request, env);
  if (!handled.ok) throw handled.error;
  return {
    response: new Response(null, { status: 204 }),
    conversationId: handled.value.conversationId,
    state: toConversationStateDto(handled.value.state),
    outcome: handled.value.outcome,
  };
}

async function provideLiveKitAccess(env: Env, conversationId: string): Promise<RouteResult> {
  const access = await createLiveKitAccess(env, conversationId);
  const state = await env.CONVERSATION_SESSIONS.getByName(conversationId).getState();
  if (state === null) {
    throw new ApiError(404, "conversation_not_found", "Conversation not found.");
  }
  return {
    response: Response.json(access satisfies LiveKitAccessResponse, {
      headers: { "Cache-Control": "no-store" },
    }),
    conversationId,
    state: toConversationStateDto(state),
    outcome: "livekit_access_ready",
  };
}

async function receiveLiveKitWebhook(request: Request, env: Env): Promise<RouteResult> {
  const handled = await handleLiveKitWebhook(request, env);
  const state = toConversationStateDto(handled.state);
  return {
    response: new Response(null, { status: 204 }),
    conversationId: handled.conversationId,
    state,
    outcome: handled.outcome,
  };
}

async function connectConversation(
  request: Request,
  env: Env,
  conversationId: string,
): Promise<RouteResult> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    throw new ApiError(426, "websocket_upgrade_required", "A WebSocket upgrade is required.", {
      Upgrade: "websocket",
    });
  }

  const headers = new Headers(request.headers);
  headers.set("Sec-WebSocket-Protocol", WIRE_SUBPROTOCOL);
  headers.set("X-Conversation-Id", conversationId);
  headers.delete("Authorization");
  headers.delete("Cookie");
  const response = await env.CONVERSATION_SESSIONS.getByName(conversationId).fetch(
    new Request(request.url, { method: "GET", headers }),
  );
  if (response.status === 404) {
    throw new ApiError(404, "conversation_not_found", "Conversation not found.");
  }
  if (response.status !== 101) {
    throw new ApiError(500, "websocket_upgrade_failed", "WebSocket upgrade failed.");
  }
  return {
    response,
    conversationId,
    state: null,
    outcome: "websocket_upgraded",
  };
}

async function createConversation(request: Request, env: Env): Promise<RouteResult> {
  const idempotencyKey = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  const conversationId = await deriveConversationId(env.CONVERSATION_ID_SECRET, idempotencyKey);
  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  const initialized = await stub.initialize(
    value.conversationSessionId(conversationId),
    value.unixMillis(Date.now()),
  );
  if (initialized.status === "rejected") {
    throw new ApiError(409, "conversation_identity_conflict", "Conversation identity conflict.");
  }
  const state = toConversationStateDto(initialized.state);
  return {
    response: Response.json(state, { status: initialized.status === "initialized" ? 201 : 200 }),
    conversationId,
    state,
    outcome: initialized.status,
  };
}

async function startConversation(env: Env, conversationId: string): Promise<RouteResult> {
  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  const current = await stub.getState();
  if (current === null) {
    throw new ApiError(404, "conversation_not_found", "Conversation not found.");
  }

  if (current.tag === ConversationStateTag.Starting) {
    return pendingStartResult(current, "already_starting");
  }
  if (current.tag !== ConversationStateTag.Created) {
    throw new ApiError(409, "conversation_not_startable", "Conversation is not startable.");
  }

  const now = Date.now();
  const applied = await stub.applyEvent({
    expectedRevision: current.revision,
    event: {
      type: ConversationEventType.StartRequested,
      eventId: `${START_EVENT_PREFIX}${conversationId}`,
      at: value.unixMillis(now),
      startDeadlineAt: value.unixMillis(now + STARTING_WINDOW_MS),
    },
  });

  if (applied.outcome === "duplicate") {
    return pendingStartResult(applied.state, "already_starting");
  }
  if (applied.outcome === "applied") {
    return pendingStartResult(applied.state, "start_requested");
  }

  // A concurrent command may have won after the initial state read.
  const latest = await stub.getState();
  if (latest?.tag === ConversationStateTag.Starting) {
    return pendingStartResult(latest, "already_starting");
  }
  throw new ApiError(409, "conversation_not_startable", "Conversation is not startable.");
}

function pendingStartResult(
  state: NonNullable<Awaited<ReturnType<ConversationSession["getState"]>>>,
  outcome: string,
): RouteResult {
  const dto = toConversationStateDto(state);
  return {
    response: Response.json(dto satisfies StartConversationResponse, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    }),
    conversationId: dto.conversationId,
    state: dto,
    outcome,
  };
}

async function getConversationState(env: Env, conversationId: string): Promise<RouteResult> {
  const state = await env.CONVERSATION_SESSIONS.getByName(conversationId).getState();
  if (state === null) {
    throw new ApiError(404, "conversation_not_found", "Conversation not found.");
  }
  return stateResult(state, "state_returned");
}

function stateResult(
  state: NonNullable<Awaited<ReturnType<ConversationSession["getState"]>>>,
  outcome: string,
): RouteResult {
  const dto = toConversationStateDto(state);
  return {
    response: Response.json(dto),
    conversationId: dto.conversationId,
    state: dto,
    outcome,
  };
}

function matchRoute(pathname: string): MatchedRoute | null {
  if (pathname === "/v1/auth/login") {
    return { name: "login", allowedMethods: ["POST"], conversationId: null };
  }
  if (pathname === "/v1/auth/logout") {
    return { name: "logout", allowedMethods: ["POST"], conversationId: null };
  }
  if (pathname === "/v1/auth/session") {
    return { name: "auth_session", allowedMethods: ["GET"], conversationId: null };
  }
  if (pathname === "/v1/integrations/livekit/webhook") {
    return { name: "livekit_webhook", allowedMethods: ["POST"], conversationId: null };
  }
  if (pathname === "/v1/integrations/livekit/agent-events") {
    return { name: "livekit_agent_event", allowedMethods: ["POST"], conversationId: null };
  }
  if (pathname === "/v1/conversations") {
    return { name: "create_conversation", allowedMethods: ["POST"], conversationId: null };
  }

  const match = /^\/v1\/conversations\/([^/]+)\/(start|state|connect|livekit-access)$/.exec(
    pathname,
  );
  if (match === null) {
    return null;
  }
  const conversationId = match[1];
  if (conversationId === undefined || !UUID_PATTERN.test(conversationId)) {
    throw new ApiError(400, "invalid_conversation_id", "Conversation ID must be a canonical UUID.");
  }
  switch (match[2]) {
    case "start":
      return { name: "start_conversation", allowedMethods: ["POST"], conversationId };
    case "state":
      return { name: "get_state", allowedMethods: ["GET"], conversationId };
    case "connect":
      return { name: "connect", allowedMethods: ["GET"], conversationId };
    case "livekit-access":
      return { name: "livekit_access", allowedMethods: ["POST", "DELETE"], conversationId };
    default:
      return null;
  }
}

function authResult(response: Response, outcome: string): RouteResult {
  return { response, conversationId: null, state: null, outcome };
}

function authSessionResult(user: AuthenticatedUser): RouteResult {
  return authResult(
    Response.json({ username: user.username }, { headers: { "Cache-Control": "no-store" } }),
    "session_returned",
  );
}

function requiresSameOrigin(route: MatchedRoute, request: Request): boolean {
  return (
    route.name === "logout" ||
    route.name === "connect" ||
    (route.name !== "auth_session" && request.method !== "GET")
  );
}

function requireBrowserOrigin(origin: string | null): void {
  if (origin === null) {
    throw new ApiError(
      403,
      "origin_required",
      "Browser requests require an allowed Origin header.",
    );
  }
}

function requireConversationId(route: MatchedRoute): string {
  if (route.conversationId === null) {
    throw new Error("Matched conversation route has no conversation ID");
  }
  return route.conversationId;
}

async function assertNoBody(request: Request): Promise<void> {
  if (request.body === null) return;

  const reader = request.body.getReader();
  const first = await reader.read();
  await reader.cancel();
  if (first.done) return;

  throw new ApiError(
    400,
    "unexpected_request_body",
    "This endpoint does not accept a request body.",
  );
}

function validateSmallHeaders(request: Request): void {
  if ((request.headers.get("Authorization")?.length ?? 0) > MAX_AUTHORIZATION_LENGTH) {
    throw new ApiError(431, "request_header_too_large", "A request header is too large.");
  }
  if ((request.headers.get("Content-Type")?.length ?? 0) > MAX_CONTENT_TYPE_LENGTH) {
    throw new ApiError(431, "request_header_too_large", "A request header is too large.");
  }
  if (
    (request.headers.get("Sec-WebSocket-Protocol")?.length ?? 0) > MAX_WEBSOCKET_PROTOCOL_LENGTH
  ) {
    throw new ApiError(431, "request_header_too_large", "A request header is too large.");
  }
}

function withRequestMetadata(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function emitRequestTelemetry(
  request: Request,
  route: MatchedRoute | null,
  result: RouteResult,
  status: number,
  startedAt: number,
  requestId: string,
): void {
  const record: RequestTelemetry = {
    kind: "conversation_http_request",
    level: status >= 500 ? "error" : "info",
    requestId,
    method: request.method,
    route: route?.name ?? "unknown",
    status,
    durationMs: Date.now() - startedAt,
    conversationId: result.conversationId,
    resultingState: result.state?.state ?? null,
    resultingRevision: result.state?.revision ?? null,
    outcome: result.outcome,
  };
  console.log(JSON.stringify(record));
}
