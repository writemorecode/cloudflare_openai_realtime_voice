/** Hono application assembly for the Worker REST and WebSocket API. */
import { requestId } from "hono/request-id";

import type { FoundationDependencies } from "../ports/foundation";
import { ApiError } from "./api-errors";
import {
  apiError,
  apiFactory,
  initializeRequest,
  internalError,
  originPolicy,
  requireConfiguration,
} from "./hono-api";
import { createAuthRoutes } from "./routes/auth-routes";
import { createConversationRoutes } from "./routes/conversation-routes";
import {
  createAgentQuestionRoutes,
  createExaminationRoutes,
  createExaminationSessionRoutes,
} from "./routes/examination-routes";
import { createIntegrationRoutes } from "./routes/integration-routes";

export type { StartConversationResponse } from "./routes/conversation-routes";

export function createConversationApi(dependencies: FoundationDependencies) {
  const app = apiFactory.createApp();

  app.use(
    "*",
    requestId({
      headerName: "",
      generator: () => dependencies.ids.randomUuid(),
    }),
  );
  app.use("*", initializeRequest(dependencies));
  app.use("*", requireConfiguration);
  app.use("*", originPolicy);

  app.route("/v1/auth", createAuthRoutes());
  app.route("/v1/examinations", createExaminationRoutes());
  app.route("/v1/examination-sessions", createExaminationSessionRoutes());
  app.route("/v1/conversations", createConversationRoutes());
  app.route("/v1/integrations/examinations/conversations", createAgentQuestionRoutes());
  app.route("/v1/integrations", createIntegrationRoutes());

  app.notFound((context) =>
    apiError(context, new ApiError(404, "route_not_found", "The requested route does not exist.")),
  );
  app.onError((cause, context) => apiError(context, internalError(cause)));

  return app;
}

export function handleConversationRequest(
  request: Request,
  env: Env,
  dependencies: FoundationDependencies,
): Promise<Response> {
  return Promise.resolve(createConversationApi(dependencies).fetch(request, env));
}
