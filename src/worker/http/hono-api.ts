import { Result } from "better-result";
import { cors } from "hono/cors";
import { createFactory } from "hono/factory";
import type { RequestIdVariables } from "hono/request-id";

import type { FoundationDependencies } from "../ports/foundation";
import { observableError } from "../../shared/observable-error";
import { ApiError, problemResponse } from "./api-errors";
import { authenticateBrowserSession, type AuthenticatedUser } from "./browser-auth";
import type { ConversationStateDto } from "./conversation-state-dto";

const MAX_AUTHORIZATION_LENGTH = 512;
const MAX_CONTENT_TYPE_LENGTH = 128;
const MAX_WEBSOCKET_PROTOCOL_LENGTH = 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const CORS_ALLOWED_HEADERS = ["Content-Type", "Idempotency-Key"];

export type ApiRouteName =
  | "login"
  | "logout"
  | "auth_session"
  | "examinations"
  | "examination"
  | "create_examination_session"
  | "examination_sessions"
  | "examination_session"
  | "examination_recording"
  | "create_conversation"
  | "start_conversation"
  | "get_state"
  | "connect"
  | "realtime_call"
  | "realtime_tool"
  | "recording_begin"
  | "recording_upload_begin"
  | "recording_part"
  | "recording_complete"
  | "recording_abort";

interface ApiVariables extends RequestIdVariables {
  dependencies: FoundationDependencies;
  startedAt: number;
  routeName: ApiRouteName | "unknown";
  conversationId: string | null;
  resourceId: string | null;
  state: ConversationStateDto | null;
  outcome: string;
  origin: string | null;
  user: AuthenticatedUser | null;
}

export interface ApiEnvironment {
  Bindings: Env;
  Variables: ApiVariables;
}

export interface HttpResult {
  readonly response: Response;
  readonly conversationId: string | null;
  readonly outcome: string;
  readonly state?: ConversationStateDto | null;
}

export type ApiResult<T> = Result<T, ApiError>;
export const apiFactory = createFactory<ApiEnvironment>();

export const initializeRequest = (dependencies: FoundationDependencies) =>
  apiFactory.createMiddleware(async (context, next) => {
    context.set("dependencies", dependencies);
    context.set("startedAt", dependencies.clock.now());
    context.set("routeName", "unknown");
    context.set("conversationId", null);
    context.set("resourceId", null);
    context.set("state", null);
    context.set("outcome", "unhandled_request");
    context.set("origin", null);
    context.set("user", null);

    await next();

    const requestId = context.get("requestId");
    if (context.res.status !== 101) context.header("X-Request-Id", requestId);
    console.log(
      JSON.stringify({
        kind: "conversation_http_request",
        level: context.res.status >= 500 ? "error" : "info",
        requestId,
        method: context.req.method,
        route: context.get("routeName"),
        status: context.res.status,
        durationMs: dependencies.clock.now() - context.get("startedAt"),
        conversationId: context.get("conversationId"),
        resultingState: context.get("state")?.state ?? null,
        resultingRevision: context.get("state")?.revision ?? null,
        outcome: context.get("outcome"),
      }),
    );
  });

export const requireConfiguration = apiFactory.createMiddleware(async (context, next) => {
  const missingBindings = missingRequiredApiBindings(context.env);
  if (missingBindings.length > 0) {
    return apiError(
      context,
      new ApiError(
        500,
        "api_not_configured",
        "The API is not configured.",
        {},
        new Error(`Required Worker bindings are missing: ${missingBindings.join(", ")}.`),
        {
          component: "worker_configuration",
          missingBindings: missingBindings.join(","),
        },
      ),
    );
  }
  await next();
});

export const originPolicy = apiFactory.createMiddleware(async (context, next) => {
  const origin = context.req.header("Origin") ?? null;
  if (origin !== null) {
    const configured = parseOrigin(context.env.ALLOWED_ORIGIN);
    if (configured === null) {
      return apiError(
        context,
        new ApiError(500, "cors_not_configured", "The API origin policy is not configured."),
      );
    }
    const candidate = parseOrigin(origin);
    if (candidate === null || candidate.origin !== configured.origin) {
      return apiError(
        context,
        new ApiError(403, "origin_not_allowed", "The request origin is not allowed."),
      );
    }
  }
  context.set("origin", origin);

  if (
    origin === null ||
    context.req.method === "OPTIONS" ||
    context.req.header("Upgrade")?.toLowerCase() === "websocket"
  ) {
    await next();
    return;
  }

  return cors({ origin: (candidate) => candidate })(context, next);
});

export const validateSmallHeaders = apiFactory.createMiddleware(async (context, next) => {
  const request = context.req.raw;
  if (
    (request.headers.get("Authorization")?.length ?? 0) > MAX_AUTHORIZATION_LENGTH ||
    (request.headers.get("Content-Type")?.length ?? 0) > MAX_CONTENT_TYPE_LENGTH ||
    (request.headers.get("Sec-WebSocket-Protocol")?.length ?? 0) > MAX_WEBSOCKET_PROTOCOL_LENGTH
  ) {
    return apiError(
      context,
      new ApiError(431, "request_header_too_large", "A request header is too large."),
    );
  }
  await next();
});

export const requireBrowserOrigin = apiFactory.createMiddleware(async (context, next) => {
  if (context.get("origin") === null) {
    return apiError(
      context,
      new ApiError(403, "origin_required", "Browser requests require an allowed Origin header."),
    );
  }
  await next();
});

export const requireBrowserSession = apiFactory.createMiddleware(async (context, next) => {
  const authenticated = await authenticateBrowserSession(context.req.raw, context.env.EXAM_DB);
  if (!authenticated.isOk()) return apiError(context, authenticated.error);
  context.set("user", authenticated.value);
  await next();
});

export const requireEmptyBody = apiFactory.createMiddleware(async (context, next) => {
  const empty = await validateNoBody(context.req.raw);
  if (!empty.isOk()) return apiError(context, empty.error);
  await next();
});

export const conversationIdParam = apiFactory.createMiddleware(async (context, next) => {
  const parameterValue = context.req.param("conversationId");
  if (!isUuid(parameterValue)) {
    return apiError(
      context,
      new ApiError(400, "invalid_conversation_id", "Conversation ID must be a canonical UUID."),
    );
  }
  context.set("conversationId", parameterValue);
  await next();
});

export function resourceIdParam(
  parameter: string,
  code: "invalid_examination_id" | "invalid_examination_session_id",
  title: string,
) {
  return apiFactory.createMiddleware(async (context, next) => {
    const parameterValue = context.req.param(parameter);
    if (!isUuid(parameterValue)) return apiError(context, new ApiError(400, code, title));
    context.set("resourceId", parameterValue);
    await next();
  });
}

export function namedRoute(name: ApiRouteName) {
  return apiFactory.createMiddleware(async (context, next) => {
    context.set("routeName", name);
    await next();
  });
}

export function preflight(allowedMethods: readonly string[]) {
  return apiFactory.createHandlers(async (context) => {
    if (context.get("origin") === null) {
      return apiError(
        context,
        new ApiError(400, "origin_required", "CORS preflight requests require an Origin header."),
      );
    }
    context.set("outcome", "preflight");
    const middleware = cors({
      origin: (candidate) => candidate,
      allowMethods: [...allowedMethods],
      allowHeaders: CORS_ALLOWED_HEADERS,
      maxAge: 600,
    });
    return middleware(context, async () => undefined);
  });
}

export function methodNotAllowed(allowedMethods: readonly string[]) {
  return apiFactory.createHandlers((context) =>
    apiError(
      context,
      new ApiError(405, "method_not_allowed", "The request method is not allowed.", {
        Allow: allowedMethods.join(", "),
      }),
    ),
  );
}

export function respond(context: Parameters<typeof apiError>[0], result: ApiResult<HttpResult>) {
  if (!result.isOk()) return apiError(context, result.error);
  context.set("conversationId", result.value.conversationId);
  context.set("state", result.value.state ?? null);
  context.set("outcome", result.value.outcome);
  return result.value.response;
}

export function apiError(
  context: import("hono").Context<ApiEnvironment>,
  error: ApiError,
): Response {
  context.set("outcome", error.code);
  console.error({
    kind: "conversation_http_error",
    requestId: context.get("requestId"),
    method: context.req.method,
    path: new URL(context.req.url).pathname,
    route: context.get("routeName"),
    status: error.status,
    code: error.code,
    ...error.telemetry,
    error: observableError(error),
  });
  return problemResponse(error, context.get("requestId"));
}

export function currentUser(
  context: import("hono").Context<ApiEnvironment>,
): Result<AuthenticatedUser, ApiError> {
  const user = context.get("user");
  return user === null
    ? Result.err(new ApiError(500, "internal_error", "The authenticated user was not initialized."))
    : Result.ok(user);
}

export function getConversationId(
  context: import("hono").Context<ApiEnvironment>,
): Result<string, ApiError> {
  const value = context.get("conversationId");
  return value === null
    ? Result.err(
        new ApiError(500, "internal_error", "The conversation identifier was not initialized."),
      )
    : Result.ok(value);
}

export function getResourceId(
  context: import("hono").Context<ApiEnvironment>,
): Result<string, ApiError> {
  const value = context.get("resourceId");
  return value === null
    ? Result.err(
        new ApiError(500, "internal_error", "The resource identifier was not initialized."),
      )
    : Result.ok(value);
}

export function internalError(cause: unknown): ApiError {
  return new ApiError(500, "internal_error", "The request could not be completed.", {}, cause);
}

async function validateNoBody(request: Request): Promise<ApiResult<void>> {
  if (request.body === null) return Result.ok(undefined);
  const reader = request.body.getReader();
  const read = await Result.tryPromise({
    try: async () => {
      const first = await reader.read();
      await reader.cancel();
      return first;
    },
    catch: internalError,
  });
  if (!read.isOk()) return read;
  return read.value.done
    ? Result.ok(undefined)
    : Result.err(
        new ApiError(
          400,
          "unexpected_request_body",
          "This endpoint does not accept a request body.",
        ),
      );
}

function isUuid(value: string | undefined): value is string {
  return value !== undefined && UUID_PATTERN.test(value);
}

type RequiredApiBindingName = "OPENAI_API_KEY" | "CONVERSATION_ID_SECRET" | "ALLOWED_ORIGIN";

export function missingRequiredApiBindings(
  env: Partial<Record<RequiredApiBindingName, unknown>>,
): readonly string[] {
  return [
    requiredStringBinding("OPENAI_API_KEY", env.OPENAI_API_KEY),
    requiredStringBinding("CONVERSATION_ID_SECRET", env.CONVERSATION_ID_SECRET),
    requiredStringBinding("ALLOWED_ORIGIN", env.ALLOWED_ORIGIN),
  ].filter((binding): binding is string => binding !== null);
}

function requiredStringBinding(name: string, value: unknown): string | null {
  return typeof value !== "string" || value.length === 0 ? name : null;
}

function parseOrigin(value: string): URL | null {
  const url = URL.parse(value);
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return null;
  }
  return url;
}
