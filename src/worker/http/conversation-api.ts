/** Stateless Cloudflare Worker HTTP router for application and provider integration requests. */
import {
  ConversationEventType,
  ConversationStateTag,
  value,
  type ConversationState,
} from "../../domain/conversation-state-machine";
import type { ApplyEventResult, InitializeResult } from "../../durable-object/conversation-session";
import type { AggregateStoreResult } from "../../durable-object/conversation-aggregate-store";
import { ApiError, problemResponse } from "./api-errors";
import { preflightResponse, validateOrigin, withCors } from "./api-cors";
import { deriveConversationId, validateIdempotencyKey } from "./api-security";
import { authenticateBearer } from "./api-security";
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
import { err, ok, tryCatch, type Result } from "@ai-oral-exam/result";
import type { FoundationDependencies } from "../ports/foundation";
import {
  completeAgentCurrentQuestion,
  createExamination,
  createExaminationSession,
  getAgentCurrentQuestion,
  getExamination,
  getExaminations,
  getExaminationSession,
  getExaminationSessionRecording,
  getExaminationSessions,
  type ExaminationApiResult,
} from "../examinations/examination-api";
import { Hono, type Context } from "hono";

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
  | "examinations"
  | "examination"
  | "create_examination_session"
  | "examination_sessions"
  | "examination_session"
  | "examination_recording"
  | "agent_current_examination_question"
  | "agent_complete_examination_question"
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
  readonly resourceId?: string;
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

interface HonoEnvironment {
  readonly Bindings: Env;
  readonly Variables: {
    readonly requestId: string;
    readonly startedAt: number;
    readonly route: MatchedRoute | null;
    readonly origin: string | null;
    readonly routeResult: RouteResult | null;
  };
}

type ApiContext = Context<HonoEnvironment>;

export type StartConversationResponse = ConversationStateDto;

export function createConversationApi(dependencies: FoundationDependencies): Hono<HonoEnvironment> {
  const app = new Hono<HonoEnvironment>();

  app.use("*", async (context, next) => {
    const startedAt = dependencies.clock.now();
    const requestId = dependencies.ids.randomUuid();
    context.set("startedAt", startedAt);
    context.set("requestId", requestId);
    context.set("route", null);
    context.set("origin", null);
    context.set("routeResult", null);

    const configured = validateConfiguration(context.env);
    if (!configured.ok) {
      setRouteResponse(context, errorRouteResult(configured.error, requestId, null));
    } else {
      const validOrigin = validateOrigin(context.req.raw, context.env.ALLOWED_ORIGIN);
      if (!validOrigin.ok) {
        setRouteResponse(context, errorRouteResult(validOrigin.error, requestId, null));
      } else {
        context.set("origin", validOrigin.value);
        await next();
      }
    }

    const route = context.get("route");
    const result =
      context.get("routeResult") ??
      errorRouteResult(
        new ApiError(500, "internal_error", "The request could not be completed."),
        requestId,
        route?.conversationId ?? null,
      );

    if (result.response.status === 101) {
      emitRequestTelemetry(
        context.req.raw,
        route,
        result,
        101,
        startedAt,
        requestId,
        dependencies.clock,
      );
      return result.response;
    }

    const response = withRequestMetadata(
      withCors(result.response, context.get("origin")),
      requestId,
    );
    emitRequestTelemetry(
      context.req.raw,
      route,
      result,
      response.status,
      startedAt,
      requestId,
      dependencies.clock,
    );
    context.res = response;
    return response;
  });

  registerRoutes(app, dependencies);
  app.notFound((context) =>
    setRouteResponse(
      context,
      errorRouteResult(
        new ApiError(404, "route_not_found", "The requested route does not exist."),
        context.get("requestId"),
        null,
      ),
    ),
  );
  app.onError((cause, context) => {
    const error = cause instanceof ApiError ? cause : httpOperationFailed(cause);
    const requestId = context.get("requestId");
    if (error.status >= 500 && error.cause !== undefined) logHttpError(error, requestId);
    return setRouteResponse(
      context,
      errorRouteResult(error, requestId, context.get("route")?.conversationId ?? null),
    );
  });
  return app;
}

export function handleConversationRequest(
  request: Request,
  env: Env,
  dependencies: FoundationDependencies,
): Promise<Response> {
  return Promise.resolve(createConversationApi(dependencies).fetch(request, env));
}

async function processMatchedRequest(
  request: Request,
  env: Env,
  route: MatchedRoute,
  origin: string | null,
  dependencies: FoundationDependencies,
): Promise<ApiResult<RouteResult>> {
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
  let authenticatedUser: AuthenticatedUser | null = null;
  if (route.name === "livekit_webhook") {
    // LiveKit authenticates this route with its signed webhook JWT.
  } else if (
    route.name === "livekit_agent_event" ||
    route.name === "agent_current_examination_question" ||
    route.name === "agent_complete_examination_question"
  ) {
    // The integration handler verifies the agent-only bearer credential.
    if (route.name !== "livekit_agent_event") {
      const authenticated = authenticateBearer(request, env.AGENT_CALLBACK_TOKEN);
      if (!authenticated.ok) return authenticated;
    }
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
    authenticatedUser = authenticated.value;
  }
  return dispatch(request, env, route, authenticatedUser, dependencies);
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
  authenticatedUser: AuthenticatedUser | null,
  dependencies: FoundationDependencies,
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
      return authenticatedUser === null
        ? err(new ApiError(401, "session_unauthorized", "Authentication is required."))
        : ok(authSessionResult(authenticatedUser));
    }
    case "examinations": {
      const user = requireAuthenticatedUser(authenticatedUser);
      if (!user.ok) return user;
      const handled =
        request.method === "POST"
          ? await createExamination(request, user.value, env, dependencies)
          : await getExaminations(env);
      return examinationRouteResult(handled);
    }
    case "examination": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const examinationId = requireResourceId(route);
      if (!examinationId.ok) return examinationId;
      return examinationRouteResult(await getExamination(examinationId.value, env));
    }
    case "create_examination_session": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const user = requireAuthenticatedUser(authenticatedUser);
      if (!user.ok) return user;
      const examinationId = requireResourceId(route);
      if (!examinationId.ok) return examinationId;
      return examinationRouteResult(
        await createExaminationSession(request, examinationId.value, user.value, env, dependencies),
      );
    }
    case "examination_sessions": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const user = requireAuthenticatedUser(authenticatedUser);
      if (!user.ok) return user;
      return examinationRouteResult(await getExaminationSessions(user.value, env, dependencies));
    }
    case "examination_session": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const user = requireAuthenticatedUser(authenticatedUser);
      if (!user.ok) return user;
      const examinationSessionId = requireResourceId(route);
      if (!examinationSessionId.ok) return examinationSessionId;
      return examinationRouteResult(
        await getExaminationSession(examinationSessionId.value, user.value, env, dependencies),
      );
    }
    case "examination_recording": {
      const user = requireAuthenticatedUser(authenticatedUser);
      if (!user.ok) return user;
      const examinationSessionId = requireResourceId(route);
      if (!examinationSessionId.ok) return examinationSessionId;
      return examinationRouteResult(
        await getExaminationSessionRecording(
          request,
          examinationSessionId.value,
          user.value,
          env,
          dependencies,
        ),
      );
    }
    case "agent_current_examination_question": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const conversationId = requireConversationId(route);
      return conversationId.ok
        ? examinationRouteResult(await getAgentCurrentQuestion(conversationId.value, env))
        : conversationId;
    }
    case "agent_complete_examination_question": {
      const conversationId = requireConversationId(route);
      return conversationId.ok
        ? examinationRouteResult(
            await completeAgentCurrentQuestion(request, conversationId.value, env, dependencies),
          )
        : conversationId;
    }
    case "create_conversation": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      return createConversation(request, env, dependencies);
    }
    case "start_conversation": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const conversationId = requireConversationId(route);
      return conversationId.ok
        ? startConversation(conversationId.value, dependencies)
        : conversationId;
    }
    case "get_state": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const conversationId = requireConversationId(route);
      return conversationId.ok
        ? getConversationState(conversationId.value, dependencies)
        : conversationId;
    }
    case "connect": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const conversationId = requireConversationId(route);
      return conversationId.ok
        ? connectConversation(request, conversationId.value, dependencies)
        : conversationId;
    }
    case "livekit_access": {
      const empty = await validateNoBody(request);
      if (!empty.ok) return empty;
      const conversationId = requireConversationId(route);
      if (!conversationId.ok) return conversationId;
      return request.method === "DELETE"
        ? releaseLiveKitAccess(env, conversationId.value, dependencies)
        : provideLiveKitAccess(env, conversationId.value, dependencies);
    }
    case "livekit_webhook":
      return receiveLiveKitWebhook(request, env, dependencies);
    case "livekit_agent_event":
      return receiveLiveKitAgentEvent(request, env, dependencies);
  }
}

async function releaseLiveKitAccess(
  env: Env,
  conversationId: string,
  dependencies: FoundationDependencies,
): Promise<ApiResult<RouteResult>> {
  const outcome = await stopLiveKitAccess(env, conversationId, dependencies);
  if (!outcome.ok) return outcome;
  const state = await conversationState(conversationId, dependencies);
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
  dependencies: FoundationDependencies,
): Promise<ApiResult<RouteResult>> {
  const handled = await handleAgentEvent(request, env, dependencies);
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
  dependencies: FoundationDependencies,
): Promise<ApiResult<RouteResult>> {
  const access = await createLiveKitAccess(env, conversationId, dependencies);
  if (!access.ok) return access;
  const state = await conversationState(conversationId, dependencies);
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

async function receiveLiveKitWebhook(
  request: Request,
  env: Env,
  dependencies: FoundationDependencies,
): Promise<ApiResult<RouteResult>> {
  const handled = await handleLiveKitWebhook(request, env, dependencies);
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
  conversationId: string,
  dependencies: FoundationDependencies,
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
      dependencies.conversations
        .get(conversationId)
        .fetch(new Request(request.url, { method: "GET", headers })),
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

async function createConversation(
  request: Request,
  env: Env,
  dependencies: FoundationDependencies,
): Promise<ApiResult<RouteResult>> {
  const idempotencyKey = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotencyKey.ok) return idempotencyKey;
  const derivedConversationId = await deriveConversationId(
    env.CONVERSATION_ID_SECRET,
    idempotencyKey.value,
  );
  if (!derivedConversationId.ok) return derivedConversationId;
  const conversationId = derivedConversationId.value;
  const stub = dependencies.conversations.get(conversationId);
  const initialized = await tryCatch(
    async (): Promise<AggregateStoreResult<InitializeResult>> =>
      await stub.initialize(
        value.conversationSessionId(conversationId),
        value.unixMillis(dependencies.clock.now()),
      ),
    httpOperationFailed,
  );
  if (!initialized.ok) return initialized;
  if (!initialized.value.ok) return err(httpOperationFailed(initialized.value.error));
  const initialization = initialized.value.value;
  if (initialization.status === "rejected") {
    return err(
      new ApiError(409, "conversation_identity_conflict", "Conversation identity conflict."),
    );
  }
  const state = toConversationStateDto(initialization.state);
  return ok({
    response: Response.json(state, {
      status: initialization.status === "initialized" ? 201 : 200,
    }),
    conversationId,
    state,
    outcome: initialization.status,
  });
}

async function startConversation(
  conversationId: string,
  dependencies: FoundationDependencies,
): Promise<ApiResult<RouteResult>> {
  const stub = dependencies.conversations.get(conversationId);
  const current = await conversationState(conversationId, dependencies);
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

  const now = dependencies.clock.now();
  const applied = await tryCatch(
    async (): Promise<AggregateStoreResult<ApplyEventResult>> =>
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
  if (!applied.value.ok) return err(httpOperationFailed(applied.value.error));
  const transition = applied.value.value;

  if (transition.outcome === "duplicate") {
    return ok(pendingStartResult(transition.state, "already_starting"));
  }
  if (transition.outcome === "applied") {
    return ok(pendingStartResult(transition.state, "start_requested"));
  }

  // A concurrent command may have won after the initial state read.
  const latest = await conversationState(conversationId, dependencies);
  if (!latest.ok) return latest;
  if (latest.value?.tag === ConversationStateTag.Starting) {
    return ok(pendingStartResult(latest.value, "already_starting"));
  }
  return err(new ApiError(409, "conversation_not_startable", "Conversation is not startable."));
}

function pendingStartResult(state: ConversationState, outcome: string): RouteResult {
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
  conversationId: string,
  dependencies: FoundationDependencies,
): Promise<ApiResult<RouteResult>> {
  const state = await conversationState(conversationId, dependencies);
  if (!state.ok) return state;
  if (state.value === null) {
    return err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  return ok(stateResult(state.value, "state_returned"));
}

function stateResult(state: ConversationState, outcome: string): RouteResult {
  const dto = toConversationStateDto(state);
  return {
    response: Response.json(dto),
    conversationId: dto.conversationId,
    state: dto,
    outcome,
  };
}

function registerRoutes(app: Hono<HonoEnvironment>, dependencies: FoundationDependencies): void {
  const route = (matchedRoute: () => ApiResult<MatchedRoute>) => async (context: ApiContext) =>
    executeRoute(context, matchedRoute(), dependencies);
  const staticRoute = (name: ApiRouteName, allowedMethods: readonly string[]) =>
    route(() => ok({ name, allowedMethods, conversationId: null }));

  app.all("/v1/auth/login", staticRoute("login", ["POST"]));
  app.all("/v1/auth/logout", staticRoute("logout", ["POST"]));
  app.all("/v1/auth/session", staticRoute("auth_session", ["GET"]));
  app.all("/v1/integrations/livekit/webhook", staticRoute("livekit_webhook", ["POST"]));
  app.all("/v1/integrations/livekit/agent-events", staticRoute("livekit_agent_event", ["POST"]));
  app.all(
    "/v1/integrations/examinations/conversations/:conversationId/current-question",
    routeForConversation("agent_current_examination_question", ["GET"], dependencies),
  );
  app.all(
    "/v1/integrations/examinations/conversations/:conversationId/complete-question",
    routeForConversation("agent_complete_examination_question", ["POST"], dependencies),
  );
  app.all("/v1/examinations", staticRoute("examinations", ["GET", "POST"]));
  app.all("/v1/examinations/:examinationId/sessions", routeForExaminationSession(dependencies));
  app.all("/v1/examinations/:examinationId", routeForExamination(dependencies));
  app.all("/v1/examination-sessions", staticRoute("examination_sessions", ["GET"]));
  app.all(
    "/v1/examination-sessions/:examinationSessionId/recording",
    routeForExaminationRecording(dependencies),
  );
  app.all(
    "/v1/examination-sessions/:examinationSessionId",
    routeForExaminationSessionRead(dependencies),
  );
  app.all("/v1/conversations", staticRoute("create_conversation", ["POST"]));
  app.all(
    "/v1/conversations/:conversationId/start",
    routeForConversation("start_conversation", ["POST"], dependencies),
  );
  app.all(
    "/v1/conversations/:conversationId/state",
    routeForConversation("get_state", ["GET"], dependencies),
  );
  app.all(
    "/v1/conversations/:conversationId/connect",
    routeForConversation("connect", ["GET"], dependencies),
  );
  app.all(
    "/v1/conversations/:conversationId/livekit-access",
    routeForConversation("livekit_access", ["POST", "DELETE"], dependencies),
  );
}

function routeForConversation(
  name: ApiRouteName,
  allowedMethods: readonly string[],
  dependencies: FoundationDependencies,
) {
  return (context: ApiContext) =>
    executeRoute(
      context,
      conversationMatchedRoute(name, allowedMethods, context.req.param("conversationId")),
      dependencies,
    );
}

function routeForExaminationSession(dependencies: FoundationDependencies) {
  return (context: ApiContext) =>
    executeRoute(
      context,
      resourceMatchedRoute(
        "create_examination_session",
        ["POST"],
        context.req.param("examinationId"),
        "invalid_examination_id",
        "Examination ID must be a canonical UUID.",
      ),
      dependencies,
    );
}

function routeForExamination(dependencies: FoundationDependencies) {
  return (context: ApiContext) =>
    executeRoute(
      context,
      resourceMatchedRoute(
        "examination",
        ["GET"],
        context.req.param("examinationId"),
        "invalid_examination_id",
        "Examination ID must be a canonical UUID.",
      ),
      dependencies,
    );
}

function routeForExaminationRecording(dependencies: FoundationDependencies) {
  return (context: ApiContext) =>
    executeRoute(
      context,
      resourceMatchedRoute(
        "examination_recording",
        ["GET"],
        context.req.param("examinationSessionId"),
        "invalid_examination_session_id",
        "Examination session ID must be a canonical UUID.",
      ),
      dependencies,
    );
}

function routeForExaminationSessionRead(dependencies: FoundationDependencies) {
  return (context: ApiContext) =>
    executeRoute(
      context,
      resourceMatchedRoute(
        "examination_session",
        ["GET"],
        context.req.param("examinationSessionId"),
        "invalid_examination_session_id",
        "Examination session ID must be a canonical UUID.",
      ),
      dependencies,
    );
}

function conversationMatchedRoute(
  name: ApiRouteName,
  allowedMethods: readonly string[],
  conversationId: string | undefined,
): ApiResult<MatchedRoute> {
  if (conversationId === undefined || !UUID_PATTERN.test(conversationId)) {
    return err(
      new ApiError(400, "invalid_conversation_id", "Conversation ID must be a canonical UUID."),
    );
  }
  return ok({ name, allowedMethods, conversationId });
}

function resourceMatchedRoute(
  name: ApiRouteName,
  allowedMethods: readonly string[],
  resourceId: string | undefined,
  code: string,
  title: string,
): ApiResult<MatchedRoute> {
  if (resourceId === undefined || !UUID_PATTERN.test(resourceId)) {
    return err(new ApiError(400, code, title));
  }
  return ok({ name, allowedMethods, conversationId: null, resourceId });
}

async function executeRoute(
  context: ApiContext,
  matchedRoute: ApiResult<MatchedRoute>,
  dependencies: FoundationDependencies,
): Promise<Response> {
  const requestId = context.get("requestId");
  if (!matchedRoute.ok) {
    return setRouteResponse(context, errorRouteResult(matchedRoute.error, requestId, null));
  }
  const route = matchedRoute.value;
  context.set("route", route);
  const processed = await tryCatch(
    () =>
      processMatchedRequest(
        context.req.raw,
        context.env,
        route,
        context.get("origin"),
        dependencies,
      ),
    httpOperationFailed,
  );
  const handled = processed.ok ? processed.value : processed;
  if (!handled.ok && handled.error.status >= 500 && handled.error.cause !== undefined) {
    logHttpError(handled.error, requestId);
  }
  return setRouteResponse(
    context,
    handled.ok ? handled.value : errorRouteResult(handled.error, requestId, route.conversationId),
  );
}

function setRouteResponse(context: ApiContext, result: RouteResult): Response {
  context.set("routeResult", result);
  context.res = result.response;
  return result.response;
}

function logHttpError(error: ApiError, requestId: string): void {
  const cause = error.cause;
  console.error(
    JSON.stringify({
      kind: "conversation_http_error",
      requestId,
      error: cause instanceof Error ? cause.name : "unknown_error",
    }),
  );
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

function requireResourceId(route: MatchedRoute): ApiResult<string> {
  return route.resourceId === undefined
    ? err(new ApiError(500, "invalid_route", "The request route is invalid."))
    : ok(route.resourceId);
}

function requireAuthenticatedUser(user: AuthenticatedUser | null): ApiResult<AuthenticatedUser> {
  return user === null
    ? err(new ApiError(401, "session_unauthorized", "Authentication is required."))
    : ok(user);
}

function examinationRouteResult(result: ApiResult<ExaminationApiResult>): ApiResult<RouteResult> {
  return result.ok
    ? ok({
        response: result.value.response,
        conversationId: result.value.conversationId,
        state: null,
        outcome: result.value.outcome,
      })
    : result;
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
  conversationId: string,
  dependencies: Pick<FoundationDependencies, "conversations">,
): Promise<ApiResult<ConversationState | null>> {
  const stub = dependencies.conversations.get(conversationId);
  const stored = await tryCatch(
    async (): Promise<AggregateStoreResult<ConversationState | null>> => await stub.getState(),
    httpOperationFailed,
  );
  if (!stored.ok) return stored;
  return stored.value.ok ? ok(stored.value.value) : err(httpOperationFailed(stored.value.error));
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
  clock: FoundationDependencies["clock"],
): void {
  const record: RequestTelemetry = {
    kind: "conversation_http_request",
    level: status >= 500 ? "error" : "info",
    requestId,
    method: request.method,
    route: route?.name ?? "unknown",
    status,
    durationMs: clock.now() - startedAt,
    conversationId: result.conversationId,
    resultingState: result.state?.state ?? null,
    resultingRevision: result.state?.revision ?? null,
    outcome: result.outcome,
  };
  console.log(JSON.stringify(record));
}
