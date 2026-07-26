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
} from "../../examinations/examination-api";
import {
  apiFactory,
  conversationIdParam,
  currentUser,
  getConversationId,
  getResourceId,
  methodNotAllowed,
  namedRoute,
  preflight,
  requireAgentBearer,
  requireBrowserOrigin,
  requireBrowserSession,
  requireEmptyBody,
  resourceIdParam,
  respond,
  validateSmallHeaders,
} from "../hono-api";

const examinationIdParam = resourceIdParam(
  "examinationId",
  "invalid_examination_id",
  "Examination ID must be a canonical UUID.",
);
const examinationSessionIdParam = resourceIdParam(
  "examinationSessionId",
  "invalid_examination_session_id",
  "Examination session ID must be a canonical UUID.",
);

export function createExaminationRoutes() {
  const app = apiFactory.createApp();
  app.use("*", validateSmallHeaders);

  app.options("/", namedRoute("examinations"), ...preflight(["GET", "POST"]));
  app.get(
    "/",
    namedRoute("examinations"),
    requireBrowserSession,
    requireEmptyBody,
    async (context) => respond(context, await getExaminations(context.env)),
  );
  app.post(
    "/",
    namedRoute("examinations"),
    requireBrowserOrigin,
    requireBrowserSession,
    async (context) =>
      respond(
        context,
        await createExamination(
          context.req.raw,
          currentUser(context),
          context.env,
          context.get("dependencies"),
        ),
      ),
  );
  app.all("/", namedRoute("examinations"), ...methodNotAllowed(["GET", "POST"]));

  app.options(
    "/:examinationId/sessions",
    namedRoute("create_examination_session"),
    ...preflight(["POST"]),
  );
  app.post(
    "/:examinationId/sessions",
    namedRoute("create_examination_session"),
    examinationIdParam,
    requireBrowserOrigin,
    requireBrowserSession,
    requireEmptyBody,
    async (context) =>
      respond(
        context,
        await createExaminationSession(
          context.req.raw,
          getResourceId(context),
          currentUser(context),
          context.env,
          context.get("dependencies"),
        ),
      ),
  );
  app.all(
    "/:examinationId/sessions",
    namedRoute("create_examination_session"),
    examinationIdParam,
    ...methodNotAllowed(["POST"]),
  );

  app.options("/:examinationId", namedRoute("examination"), ...preflight(["GET"]));
  app.get(
    "/:examinationId",
    namedRoute("examination"),
    examinationIdParam,
    requireBrowserSession,
    requireEmptyBody,
    async (context) => respond(context, await getExamination(getResourceId(context), context.env)),
  );
  app.all(
    "/:examinationId",
    namedRoute("examination"),
    examinationIdParam,
    ...methodNotAllowed(["GET"]),
  );

  return app;
}

export function createExaminationSessionRoutes() {
  const app = apiFactory.createApp();
  app.use("*", validateSmallHeaders);

  app.options("/", namedRoute("examination_sessions"), ...preflight(["GET"]));
  app.get(
    "/",
    namedRoute("examination_sessions"),
    requireBrowserSession,
    requireEmptyBody,
    async (context) =>
      respond(
        context,
        await getExaminationSessions(
          currentUser(context),
          context.env,
          context.get("dependencies"),
        ),
      ),
  );
  app.all("/", namedRoute("examination_sessions"), ...methodNotAllowed(["GET"]));

  app.options(
    "/:examinationSessionId/recording",
    namedRoute("examination_recording"),
    ...preflight(["GET"]),
  );
  app.get(
    "/:examinationSessionId/recording",
    namedRoute("examination_recording"),
    examinationSessionIdParam,
    requireBrowserSession,
    async (context) =>
      respond(
        context,
        await getExaminationSessionRecording(
          context.req.raw,
          getResourceId(context),
          currentUser(context),
          context.env,
          context.get("dependencies"),
        ),
      ),
  );
  app.all(
    "/:examinationSessionId/recording",
    namedRoute("examination_recording"),
    examinationSessionIdParam,
    ...methodNotAllowed(["GET"]),
  );

  app.options("/:examinationSessionId", namedRoute("examination_session"), ...preflight(["GET"]));
  app.get(
    "/:examinationSessionId",
    namedRoute("examination_session"),
    examinationSessionIdParam,
    requireBrowserSession,
    requireEmptyBody,
    async (context) =>
      respond(
        context,
        await getExaminationSession(
          getResourceId(context),
          currentUser(context),
          context.env,
          context.get("dependencies"),
        ),
      ),
  );
  app.all(
    "/:examinationSessionId",
    namedRoute("examination_session"),
    examinationSessionIdParam,
    ...methodNotAllowed(["GET"]),
  );

  return app;
}

export function createAgentQuestionRoutes() {
  const app = apiFactory.createApp();
  app.use("*", validateSmallHeaders);

  app.options(
    "/:conversationId/current-question",
    namedRoute("agent_current_examination_question"),
    ...preflight(["GET"]),
  );
  app.get(
    "/:conversationId/current-question",
    namedRoute("agent_current_examination_question"),
    conversationIdParam,
    requireAgentBearer,
    requireEmptyBody,
    async (context) =>
      respond(context, await getAgentCurrentQuestion(getConversationId(context), context.env)),
  );
  app.all(
    "/:conversationId/current-question",
    namedRoute("agent_current_examination_question"),
    conversationIdParam,
    ...methodNotAllowed(["GET"]),
  );

  app.options(
    "/:conversationId/complete-question",
    namedRoute("agent_complete_examination_question"),
    ...preflight(["POST"]),
  );
  app.post(
    "/:conversationId/complete-question",
    namedRoute("agent_complete_examination_question"),
    conversationIdParam,
    requireAgentBearer,
    async (context) =>
      respond(
        context,
        await completeAgentCurrentQuestion(
          context.req.raw,
          getConversationId(context),
          context.env,
          context.get("dependencies"),
        ),
      ),
  );
  app.all(
    "/:conversationId/complete-question",
    namedRoute("agent_complete_examination_question"),
    conversationIdParam,
    ...methodNotAllowed(["POST"]),
  );

  return app;
}
