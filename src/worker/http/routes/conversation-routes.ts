import { deserializeResult, WIRE_SUBPROTOCOL } from "@ai-oral-exam/conversation-contract";
import { Result } from "better-result";

import {
  ConversationEventType,
  ConversationStateTag,
  value,
  type ConversationState,
} from "../../../domain/conversation-state-machine";
import type {
  AggregateStoreError,
  AggregateStoreResult,
} from "../../../durable-object/conversation-aggregate-store";
import type {
  ApplyEventResult,
  InitializeResult,
} from "../../../durable-object/conversation-session";
import {
  createLiveKitAccess,
  stopLiveKitAccess,
  type LiveKitAccessResponse,
} from "../../integrations/livekit/access";
import type { FoundationDependencies } from "../../ports/foundation";
import { ApiError } from "../api-errors";
import { deriveConversationId, validateIdempotencyKey } from "../api-security";
import {
  apiFactory,
  conversationIdParam,
  getConversationId,
  internalError,
  methodNotAllowed,
  namedRoute,
  preflight,
  requireBrowserOrigin,
  requireBrowserSession,
  requireEmptyBody,
  respond,
  validateSmallHeaders,
  type ApiResult,
  type HttpResult,
} from "../hono-api";
import { toConversationStateDto, type ConversationStateDto } from "../conversation-state-dto";

const STARTING_WINDOW_MS = 60_000;
const START_EVENT_PREFIX = "system:http:start:v1:";

export type StartConversationResponse = ConversationStateDto;

export function createConversationRoutes() {
  const app = apiFactory.createApp();
  app.use("*", validateSmallHeaders);

  app.options("/", namedRoute("create_conversation"), ...preflight(["POST"]));
  app.post(
    "/",
    namedRoute("create_conversation"),
    requireBrowserOrigin,
    requireBrowserSession,
    requireEmptyBody,
    async (context) =>
      respond(
        context,
        await createConversation(context.req.raw, context.env, context.get("dependencies")),
      ),
  );
  app.all("/", namedRoute("create_conversation"), ...methodNotAllowed(["POST"]));

  app.options("/:conversationId/start", namedRoute("start_conversation"), ...preflight(["POST"]));
  app.post(
    "/:conversationId/start",
    namedRoute("start_conversation"),
    conversationIdParam,
    requireBrowserOrigin,
    requireBrowserSession,
    requireEmptyBody,
    async (context) =>
      respond(
        context,
        await startConversation(getConversationId(context), context.get("dependencies")),
      ),
  );
  app.all(
    "/:conversationId/start",
    namedRoute("start_conversation"),
    conversationIdParam,
    ...methodNotAllowed(["POST"]),
  );

  app.options("/:conversationId/state", namedRoute("get_state"), ...preflight(["GET"]));
  app.get(
    "/:conversationId/state",
    namedRoute("get_state"),
    conversationIdParam,
    requireBrowserSession,
    requireEmptyBody,
    async (context) =>
      respond(
        context,
        await getConversationState(getConversationId(context), context.get("dependencies")),
      ),
  );
  app.all(
    "/:conversationId/state",
    namedRoute("get_state"),
    conversationIdParam,
    ...methodNotAllowed(["GET"]),
  );

  app.options("/:conversationId/connect", namedRoute("connect"), ...preflight(["GET"]));
  app.get(
    "/:conversationId/connect",
    namedRoute("connect"),
    conversationIdParam,
    requireBrowserOrigin,
    requireBrowserSession,
    requireEmptyBody,
    async (context) =>
      respond(
        context,
        await connectConversation(
          context.req.raw,
          getConversationId(context),
          context.get("dependencies"),
        ),
      ),
  );
  app.all(
    "/:conversationId/connect",
    namedRoute("connect"),
    conversationIdParam,
    ...methodNotAllowed(["GET"]),
  );

  app.options(
    "/:conversationId/livekit-access",
    namedRoute("livekit_access"),
    ...preflight(["POST", "DELETE"]),
  );
  app.post(
    "/:conversationId/livekit-access",
    namedRoute("livekit_access"),
    conversationIdParam,
    requireBrowserOrigin,
    requireBrowserSession,
    requireEmptyBody,
    async (context) =>
      respond(
        context,
        await provideLiveKitAccess(
          context.env,
          getConversationId(context),
          context.get("dependencies"),
        ),
      ),
  );
  app.delete(
    "/:conversationId/livekit-access",
    namedRoute("livekit_access"),
    conversationIdParam,
    requireBrowserOrigin,
    requireBrowserSession,
    requireEmptyBody,
    async (context) =>
      respond(
        context,
        await releaseLiveKitAccess(
          context.env,
          getConversationId(context),
          context.get("dependencies"),
        ),
      ),
  );
  app.all(
    "/:conversationId/livekit-access",
    namedRoute("livekit_access"),
    conversationIdParam,
    ...methodNotAllowed(["POST", "DELETE"]),
  );

  return app;
}

async function releaseLiveKitAccess(
  env: Env,
  conversationId: string,
  dependencies: FoundationDependencies,
): Promise<ApiResult<HttpResult>> {
  const outcome = await stopLiveKitAccess(env, conversationId, dependencies);
  if (!outcome.isOk()) return outcome;
  const state = await conversationState(conversationId, dependencies);
  if (!state.isOk()) return state;
  if (state.value === null) {
    return Result.err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  return Result.ok({
    response: new Response(null, { status: 204 }),
    conversationId,
    state: toConversationStateDto(state.value),
    outcome: outcome.value,
  });
}

async function provideLiveKitAccess(
  env: Env,
  conversationId: string,
  dependencies: FoundationDependencies,
): Promise<ApiResult<HttpResult>> {
  const access = await createLiveKitAccess(env, conversationId, dependencies);
  if (!access.isOk()) return access;
  const state = await conversationState(conversationId, dependencies);
  if (!state.isOk()) return state;
  if (state.value === null) {
    return Result.err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  return Result.ok({
    response: Response.json(access.value satisfies LiveKitAccessResponse, {
      headers: { "Cache-Control": "no-store" },
    }),
    conversationId,
    state: toConversationStateDto(state.value),
    outcome: "livekit_access_ready",
  });
}

async function connectConversation(
  request: Request,
  conversationId: string,
  dependencies: FoundationDependencies,
): Promise<ApiResult<HttpResult>> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return Result.err(
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
  const response = await Result.tryPromise({
    try: () =>
      dependencies.conversations
        .get(conversationId)
        .fetch(new Request(request.url, { method: "GET", headers })),
    catch: internalError,
  });
  if (!response.isOk()) return response;
  if (response.value.status === 404) {
    return Result.err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  if (response.value.status !== 101) {
    return Result.err(new ApiError(500, "websocket_upgrade_failed", "WebSocket upgrade failed."));
  }
  return Result.ok({
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
): Promise<ApiResult<HttpResult>> {
  const idempotencyKey = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotencyKey.isOk()) return idempotencyKey;
  const derivedConversationId = await deriveConversationId(
    env.CONVERSATION_ID_SECRET,
    idempotencyKey.value,
  );
  if (!derivedConversationId.isOk()) return derivedConversationId;
  const conversationId = derivedConversationId.value;
  const initialized = await Result.tryPromise({
    try: async (): Promise<AggregateStoreResult<InitializeResult>> =>
      deserializeResult<InitializeResult, AggregateStoreError>(
        await dependencies.conversations
          .get(conversationId)
          .initialize(
            value.conversationSessionId(conversationId),
            value.unixMillis(dependencies.clock.now()),
          ),
      ),
    catch: internalError,
  });
  if (!initialized.isOk()) return initialized;
  if (!initialized.value.isOk()) return Result.err(internalError(initialized.value.error));
  const initialization = initialized.value.value;
  if (initialization.status === "rejected") {
    return Result.err(
      new ApiError(409, "conversation_identity_conflict", "Conversation identity conflict."),
    );
  }
  const state = toConversationStateDto(initialization.state);
  return Result.ok({
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
): Promise<ApiResult<HttpResult>> {
  const stub = dependencies.conversations.get(conversationId);
  const current = await conversationState(conversationId, dependencies);
  if (!current.isOk()) return current;
  if (current.value === null) {
    return Result.err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  const currentState = current.value;

  if (currentState.tag === ConversationStateTag.Starting) {
    return Result.ok(pendingStartResult(currentState, "already_starting"));
  }
  if (currentState.tag !== ConversationStateTag.Created) {
    return Result.err(
      new ApiError(409, "conversation_not_startable", "Conversation is not startable."),
    );
  }

  const now = dependencies.clock.now();
  const applied = await Result.tryPromise({
    try: async (): Promise<AggregateStoreResult<ApplyEventResult>> =>
      deserializeResult<ApplyEventResult, AggregateStoreError>(
        await stub.applyEvent({
          expectedRevision: currentState.revision,
          event: {
            type: ConversationEventType.StartRequested,
            eventId: `${START_EVENT_PREFIX}${conversationId}`,
            at: value.unixMillis(now),
            startDeadlineAt: value.unixMillis(now + STARTING_WINDOW_MS),
          },
        }),
      ),
    catch: internalError,
  });
  if (!applied.isOk()) return applied;
  if (!applied.value.isOk()) return Result.err(internalError(applied.value.error));
  const transition = applied.value.value;

  if (transition.outcome === "duplicate") {
    return Result.ok(pendingStartResult(transition.state, "already_starting"));
  }
  if (transition.outcome === "applied") {
    return Result.ok(pendingStartResult(transition.state, "start_requested"));
  }

  const latest = await conversationState(conversationId, dependencies);
  if (!latest.isOk()) return latest;
  if (latest.value?.tag === ConversationStateTag.Starting) {
    return Result.ok(pendingStartResult(latest.value, "already_starting"));
  }
  return Result.err(
    new ApiError(409, "conversation_not_startable", "Conversation is not startable."),
  );
}

function pendingStartResult(state: ConversationState, outcome: string): HttpResult {
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
): Promise<ApiResult<HttpResult>> {
  const state = await conversationState(conversationId, dependencies);
  if (!state.isOk()) return state;
  if (state.value === null) {
    return Result.err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  const dto = toConversationStateDto(state.value);
  return Result.ok({
    response: Response.json(dto),
    conversationId: dto.conversationId,
    state: dto,
    outcome: "state_returned",
  });
}

async function conversationState(
  conversationId: string,
  dependencies: Pick<FoundationDependencies, "conversations">,
): Promise<ApiResult<ConversationState | null>> {
  const stored = await Result.tryPromise({
    try: async (): Promise<AggregateStoreResult<ConversationState | null>> =>
      deserializeResult<ConversationState | null, AggregateStoreError>(
        await dependencies.conversations.get(conversationId).getState(),
      ),
    catch: internalError,
  });
  if (!stored.isOk()) return stored;
  return stored.value.isOk()
    ? Result.ok(stored.value.value)
    : Result.err(internalError(stored.value.error));
}
