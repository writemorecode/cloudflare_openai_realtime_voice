/** Stateless Cloudflare Worker HTTP router for application and provider integration requests. */
import {
  ConversationEventType,
  ConversationStateTag,
  value,
  type ConversationState,
} from "../../domain/conversation-state-machine";
import type {
  ApplyEventResult,
  ConversationSession,
  InitializeResult,
} from "../../durable-object/conversation-session";
import { ApiError, problemResponse } from "./api-errors";
import { preflightResponse, validateOrigin, withCors } from "./api-cors";
import { deriveConversationId, validateIdempotencyKey } from "./api-security";
import { authenticateBrowserSession, login, logout, type AuthenticatedUser } from "./browser-auth";
import { toConversationStateDto, type ConversationStateDto } from "./conversation-state-dto";
import { WIRE_SUBPROTOCOL } from "@ai-oral-exam/conversation-contract";
import { handleLiveKitWebhook } from "../integrations/livekit/webhook";
import { handleAgentEvent } from "../integrations/livekit/agent-events";
import {
  createLiveKitAccess,
  stopLiveKitAccess,
  type LiveKitAccessResponse,
} from "../integrations/livekit/access";
import { err, ok, tryCatch, type Result } from "../try-catch";

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
  readonly resultingState: ConversationStateDto["state"] | null;
  readonly resultingRevision: number | null;
  readonly outcome: string;
}

interface RouteResult {
  readonly response: Response;
  readonly conversationId: string | null;
  readonly state: ConversationStateDto | null;
  readonly outcome: string;
}

type ApiResult<T> = Result<T, ApiError>;

export type StartConversationResponse = ConversationStateDto;

export const conversationApi = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const context: { route: MatchedRoute | null; origin: string | null } = {
      route: null,
      origin: null,
    };
    const processed = await tryCatch(async (): Promise<ApiResult<RouteResult>> => {
      const configured = validateConfiguration(env);
      if (!configured.ok) return configured;
      const validOrigin = validateOrigin(request, env.ALLOWED_ORIGIN);
      if (!validOrigin.ok) return validOrigin;
      context.origin = validOrigin.value;
      const matchedRoute = matchRoute(new URL(request.url).pathname);
      if (!matchedRoute.ok) return matchedRoute;
      context.route = matchedRoute.value;
      return processMatchedRequest(request, env, context.route, context.origin);
    }, httpOperationFailed);
    const handled = processed.ok ? processed.value : processed;
    const result = handled.ok
      ? handled.value
      : errorRouteResult(handled.error, requestId, context.route?.conversationId ?? null);

    if (!handled.ok && handled.error.status >= 500 && handled.error.cause !== undefined) {
      const cause = handled.error.cause;
      console.error(
        JSON.stringify({
          kind: "conversation_http_error",
          requestId,
          error: cause instanceof Error ? cause.name : "unknown_error",
        }),
      );
    }

    if (result.response.status === 101) {
      emitRequestTelemetry(request, context.route, result, 101, startedAt, requestId);
      return result.response;
    }
    const response = withRequestMetadata(withCors(result.response, context.origin), requestId);
    emitRequestTelemetry(request, context.route, result, response.status, startedAt, requestId);
    return response;
  },
} satisfies ExportedHandler<Env>;

async function processMatchedRequest(
  request: Request,
  env: Env,
  route: MatchedRoute | null,
  origin: string | null,
): Promise<ApiResult<RouteResult>> {
  if (route === null) {
    return err(new ApiError(404, "route_not_found", "The requested route does not exist."));
  }
  if (request.method === "OPTIONS") {
    if (origin === null) {
      return err(
        new ApiError(400, "origin_required", "CORS preflight requests require an Origin header."),
      );
    }
    return ok({
      response: preflightResponse(origin, route.allowedMethods),
      conversationId: route.conversationId,
      state: null,
      outcome: "preflight",
    });
  }
  if (!route.allowedMethods.includes(request.method)) {
    return err(
      new ApiError(405, "method_not_allowed", "The request method is not allowed.", {
        Allow: route.allowedMethods.join(", "),
      }),
    );
  }
  if (route.name !== "livekit_webhook") {
    const headers = validateSmallHeaders(request);
    if (!headers.ok) return headers;
  }
  if (route.name === "livekit_webhook") {
    // LiveKit authenticates this route with its signed webhook JWT.
  } else if (route.name === "livekit_agent_event") {
    // The integration handler verifies the agent-only bearer credential.
  } else if (route.name === "login") {
    const browserOrigin = requireBrowserOrigin(origin);
    if (!browserOrigin.ok) return browserOrigin;
  } else {
    if (requiresSameOrigin(route, request)) {
      const browserOrigin = requireBrowserOrigin(origin);
      if (!browserOrigin.ok) return browserOrigin;
    }
    const authenticated = await authenticateBrowserSession(request, env.AUTH_DB);
    if (!authenticated.ok) return authenticated;
  }
  return dispatch(request, env, route);
}

function errorRouteResult(
  error: ApiError,
  requestId: string,
  conversationId: string | null,
): RouteResult {
  return {
    response: problemResponse(error, requestId),
    conversationId,
    state: null,
    outcome: error.code,
  };
}

function validateConfiguration(env: Env): ApiResult<void> {
  if (
    env.AGENT_CALLBACK_TOKEN.length === 0 ||
    env.CONVERSATION_ID_SECRET.length === 0 ||
    env.ALLOWED_ORIGIN.length === 0
  ) {
    return err(new ApiError(500, "api_not_configured", "The API is not configured."));
  }
  return ok(undefined);
}

async function dispatch(
  request: Request,
  env: Env,
  route: MatchedRoute,
): Promise<ApiResult<RouteResult>> {
  switch (route.name) {
    case "login": {
      const loggedIn = await login(request, env.AUTH_DB);
      return loggedIn.ok ? ok(authResult(loggedIn.value, "logged_in")) : loggedIn;
    }
    case "logout": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const loggedOut = await logout(request, env.AUTH_DB);
      return loggedOut.ok ? ok(authResult(loggedOut.value, "logged_out")) : loggedOut;
    }
    case "auth_session": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const user = await authenticateBrowserSession(request, env.AUTH_DB);
      return user.ok ? ok(authSessionResult(user.value)) : user;
    }
    case "create_conversation": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      return createConversation(request, env);
    }
    case "start_conversation": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const conversationId = requireConversationId(route);
      return conversationId.ok ? startConversation(env, conversationId.value) : conversationId;
    }
    case "get_state": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const conversationId = requireConversationId(route);
      return conversationId.ok ? getConversationState(env, conversationId.value) : conversationId;
    }
    case "connect": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const conversationId = requireConversationId(route);
      return conversationId.ok
        ? connectConversation(request, env, conversationId.value)
        : conversationId;
    }
    case "livekit_access": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const conversationId = requireConversationId(route);
      if (!conversationId.ok) return conversationId;
      return request.method === "DELETE"
        ? releaseLiveKitAccess(env, conversationId.value)
        : provideLiveKitAccess(env, conversationId.value);
    }
    case "livekit_webhook":
      return receiveLiveKitWebhook(request, env);
    case "livekit_agent_event":
      return receiveLiveKitAgentEvent(request, env);
  }
}

async function releaseLiveKitAccess(
  env: Env,
  conversationId: string,
): Promise<ApiResult<RouteResult>> {
  const outcome = await stopLiveKitAccess(env, conversationId);
  if (!outcome.ok) return outcome;
  const state = await conversationState(env, conversationId);
  if (!state.ok) return state;
  if (state.value === null) {
    return err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  return ok({
    response: new Response(null, { status: 204 }),
    conversationId,
    state: toConversationStateDto(state.value),
    outcome: outcome.value,
  });
}

async function receiveLiveKitAgentEvent(
  request: Request,
  env: Env,
): Promise<ApiResult<RouteResult>> {
  const handled = await handleAgentEvent(request, env);
  if (!handled.ok) return handled;
  return ok({
    response: new Response(null, { status: 204 }),
    conversationId: handled.value.conversationId,
    state: toConversationStateDto(handled.value.state),
    outcome: handled.value.outcome,
  });
}

async function provideLiveKitAccess(
  env: Env,
  conversationId: string,
): Promise<ApiResult<RouteResult>> {
  const access = await createLiveKitAccess(env, conversationId);
  if (!access.ok) return access;
  const state = await conversationState(env, conversationId);
  if (!state.ok) return state;
  if (state.value === null) {
    return err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  return ok({
    response: Response.json(access.value satisfies LiveKitAccessResponse, {
      headers: { "Cache-Control": "no-store" },
    }),
    conversationId,
    state: toConversationStateDto(state.value),
    outcome: "livekit_access_ready",
  });
}

async function receiveLiveKitWebhook(request: Request, env: Env): Promise<ApiResult<RouteResult>> {
  const handled = await handleLiveKitWebhook(request, env);
  if (!handled.ok) return handled;
  const state = toConversationStateDto(handled.value.state);
  return ok({
    response: new Response(null, { status: 204 }),
    conversationId: handled.value.conversationId,
    state,
    outcome: handled.value.outcome,
  });
}

async function connectConversation(
  request: Request,
  env: Env,
  conversationId: string,
): Promise<ApiResult<RouteResult>> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return err(
      new ApiError(426, "websocket_upgrade_required", "A WebSocket upgrade is required.", {
        Upgrade: "websocket",
      }),
    );
  }

  const headers = new Headers(request.headers);
  headers.set("Sec-WebSocket-Protocol", WIRE_SUBPROTOCOL);
  headers.set("X-Conversation-Id", conversationId);
  headers.delete("Authorization");
  headers.delete("Cookie");
  const response = await tryCatch(
    () =>
      env.CONVERSATION_SESSIONS.getByName(conversationId).fetch(
        new Request(request.url, { method: "GET", headers }),
      ),
    httpOperationFailed,
  );
  if (!response.ok) return response;
  if (response.value.status === 404) {
    return err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  if (response.value.status !== 101) {
    return err(new ApiError(500, "websocket_upgrade_failed", "WebSocket upgrade failed."));
  }
  return ok({
    response: response.value,
    conversationId,
    state: null,
    outcome: "websocket_upgraded",
  });
}

async function createConversation(request: Request, env: Env): Promise<ApiResult<RouteResult>> {
  const idempotencyKey = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotencyKey.ok) return idempotencyKey;
  const derivedConversationId = await deriveConversationId(
    env.CONVERSATION_ID_SECRET,
    idempotencyKey.value,
  );
  if (!derivedConversationId.ok) return derivedConversationId;
  const conversationId = derivedConversationId.value;
  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  const initialized = await tryCatch(
    async (): Promise<InitializeResult> =>
      await stub.initialize(
        value.conversationSessionId(conversationId),
        value.unixMillis(Date.now()),
      ),
    httpOperationFailed,
  );
  if (!initialized.ok) return initialized;
  if (initialized.value.status === "rejected") {
    return err(
      new ApiError(409, "conversation_identity_conflict", "Conversation identity conflict."),
    );
  }
  const state = toConversationStateDto(initialized.value.state);
  return ok({
    response: Response.json(state, {
      status: initialized.value.status === "initialized" ? 201 : 200,
    }),
    conversationId,
    state,
    outcome: initialized.value.status,
  });
}

async function startConversation(
  env: Env,
  conversationId: string,
): Promise<ApiResult<RouteResult>> {
  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  const current = await conversationState(env, conversationId);
  if (!current.ok) return current;
  if (current.value === null) {
    return err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  const currentState = current.value;

  if (currentState.tag === ConversationStateTag.Starting) {
    return ok(pendingStartResult(currentState, "already_starting"));
  }
  if (currentState.tag !== ConversationStateTag.Created) {
    return err(new ApiError(409, "conversation_not_startable", "Conversation is not startable."));
  }

  const now = Date.now();
  const applied = await tryCatch(
    async (): Promise<ApplyEventResult> =>
      await stub.applyEvent({
        expectedRevision: currentState.revision,
        event: {
          type: ConversationEventType.StartRequested,
          eventId: `${START_EVENT_PREFIX}${conversationId}`,
          at: value.unixMillis(now),
          startDeadlineAt: value.unixMillis(now + STARTING_WINDOW_MS),
        },
      }),
    httpOperationFailed,
  );
  if (!applied.ok) return applied;

  if (applied.value.outcome === "duplicate") {
    return ok(pendingStartResult(applied.value.state, "already_starting"));
  }
  if (applied.value.outcome === "applied") {
    return ok(pendingStartResult(applied.value.state, "start_requested"));
  }

  // A concurrent command may have won after the initial state read.
  const latest = await conversationState(env, conversationId);
  if (!latest.ok) return latest;
  if (latest.value?.tag === ConversationStateTag.Starting) {
    return ok(pendingStartResult(latest.value, "already_starting"));
  }
  return err(new ApiError(409, "conversation_not_startable", "Conversation is not startable."));
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

async function getConversationState(
  env: Env,
  conversationId: string,
): Promise<ApiResult<RouteResult>> {
  const state = await conversationState(env, conversationId);
  if (!state.ok) return state;
  if (state.value === null) {
    return err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  return ok(stateResult(state.value, "state_returned"));
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

function matchRoute(pathname: string): ApiResult<MatchedRoute | null> {
  if (pathname === "/v1/auth/login") {
    return ok({ name: "login", allowedMethods: ["POST"], conversationId: null });
  }
  if (pathname === "/v1/auth/logout") {
    return ok({ name: "logout", allowedMethods: ["POST"], conversationId: null });
  }
  if (pathname === "/v1/auth/session") {
    return ok({ name: "auth_session", allowedMethods: ["GET"], conversationId: null });
  }
  if (pathname === "/v1/integrations/livekit/webhook") {
    return ok({ name: "livekit_webhook", allowedMethods: ["POST"], conversationId: null });
  }
  if (pathname === "/v1/integrations/livekit/agent-events") {
    return ok({ name: "livekit_agent_event", allowedMethods: ["POST"], conversationId: null });
  }
  if (pathname === "/v1/conversations") {
    return ok({ name: "create_conversation", allowedMethods: ["POST"], conversationId: null });
  }

  const match = /^\/v1\/conversations\/([^/]+)\/(start|state|connect|livekit-access)$/.exec(
    pathname,
  );
  if (match === null) {
    return ok(null);
  }
  const conversationId = match[1];
  if (conversationId === undefined || !UUID_PATTERN.test(conversationId)) {
    return err(
      new ApiError(400, "invalid_conversation_id", "Conversation ID must be a canonical UUID."),
    );
  }
  switch (match[2]) {
    case "start":
      return ok({ name: "start_conversation", allowedMethods: ["POST"], conversationId });
    case "state":
      return ok({ name: "get_state", allowedMethods: ["GET"], conversationId });
    case "connect":
      return ok({ name: "connect", allowedMethods: ["GET"], conversationId });
    case "livekit-access":
      return ok({
        name: "livekit_access",
        allowedMethods: ["POST", "DELETE"],
        conversationId,
      });
    default:
      return ok(null);
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

function requireBrowserOrigin(origin: string | null): ApiResult<void> {
  if (origin === null) {
    return err(
      new ApiError(403, "origin_required", "Browser requests require an allowed Origin header."),
    );
  }
  return ok(undefined);
}

function requireConversationId(route: MatchedRoute): ApiResult<string> {
  if (route.conversationId === null) {
    return err(new ApiError(500, "invalid_route", "The request route is invalid."));
  }
  return ok(route.conversationId);
}

async function validateNoBody(request: Request): Promise<ApiResult<void>> {
  if (request.body === null) return ok(undefined);

  const reader = request.body.getReader();
  const read = await tryCatch(async () => {
    const first = await reader.read();
    await reader.cancel();
    return first;
  }, httpOperationFailed);
  if (!read.ok) return read;
  if (read.value.done) return ok(undefined);

  return err(
    new ApiError(400, "unexpected_request_body", "This endpoint does not accept a request body."),
  );
}

function validateSmallHeaders(request: Request): ApiResult<void> {
  if ((request.headers.get("Authorization")?.length ?? 0) > MAX_AUTHORIZATION_LENGTH) {
    return err(new ApiError(431, "request_header_too_large", "A request header is too large."));
  }
  if ((request.headers.get("Content-Type")?.length ?? 0) > MAX_CONTENT_TYPE_LENGTH) {
    return err(new ApiError(431, "request_header_too_large", "A request header is too large."));
  }
  if (
    (request.headers.get("Sec-WebSocket-Protocol")?.length ?? 0) > MAX_WEBSOCKET_PROTOCOL_LENGTH
  ) {
    return err(new ApiError(431, "request_header_too_large", "A request header is too large."));
  }
  return ok(undefined);
}

async function conversationState(
  env: Env,
  conversationId: string,
): Promise<ApiResult<ConversationState | null>> {
  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  return tryCatch(
    async (): Promise<ConversationState | null> => await stub.getState(),
    httpOperationFailed,
  );
}

function httpOperationFailed(cause: unknown): ApiError {
  return new ApiError(500, "internal_error", "The request could not be completed.", {}, cause);
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
