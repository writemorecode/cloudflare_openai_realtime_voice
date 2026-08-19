import { Result } from "better-result";

import {
  createExamination,
  createExaminationSession,
  getExamination,
  getExaminations,
  getExaminationSession,
  getExaminationSessionRecording,
  getExaminationSessionTranscript,
  getExaminationSessions,
} from "../../examinations/examination-api";
import {
  apiFactory,
  currentUser,
  getResourceId,
  methodNotAllowed,
  namedRoute,
  preflight,
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
    async (context) => {
      const user = currentUser(context);
      if (!user.isOk()) return respond(context, Result.err(user.error));
      return respond(
        context,
        await createExamination(
          context.req.raw,
          user.value,
          context.env,
          context.get("dependencies"),
        ),
      );
    },
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
    async (context) => {
      const examinationId = getResourceId(context);
      if (!examinationId.isOk()) return respond(context, Result.err(examinationId.error));
      const user = currentUser(context);
      if (!user.isOk()) return respond(context, Result.err(user.error));
      return respond(
        context,
        await createExaminationSession(
          context.req.raw,
          examinationId.value,
          user.value,
          context.env,
          context.get("dependencies"),
        ),
      );
    },
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
    async (context) => {
      const examinationId = getResourceId(context);
      if (!examinationId.isOk()) return respond(context, Result.err(examinationId.error));
      return respond(context, await getExamination(examinationId.value, context.env));
    },
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
    async (context) => {
      const user = currentUser(context);
      if (!user.isOk()) return respond(context, Result.err(user.error));
      return respond(
        context,
        await getExaminationSessions(user.value, context.env, context.get("dependencies")),
      );
    },
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
    async (context) => {
      const examinationSessionId = getResourceId(context);
      if (!examinationSessionId.isOk())
        return respond(context, Result.err(examinationSessionId.error));
      const user = currentUser(context);
      if (!user.isOk()) return respond(context, Result.err(user.error));
      return respond(
        context,
        await getExaminationSessionRecording(
          context.req.raw,
          examinationSessionId.value,
          user.value,
          context.env,
          context.get("dependencies"),
        ),
      );
    },
  );
  app.all(
    "/:examinationSessionId/recording",
    namedRoute("examination_recording"),
    examinationSessionIdParam,
    ...methodNotAllowed(["GET"]),
  );

  app.options(
    "/:examinationSessionId/transcript",
    namedRoute("examination_transcript"),
    ...preflight(["GET"]),
  );
  app.get(
    "/:examinationSessionId/transcript",
    namedRoute("examination_transcript"),
    examinationSessionIdParam,
    requireBrowserSession,
    requireEmptyBody,
    async (context) => {
      const examinationSessionId = getResourceId(context);
      if (!examinationSessionId.isOk())
        return respond(context, Result.err(examinationSessionId.error));
      const user = currentUser(context);
      if (!user.isOk()) return respond(context, Result.err(user.error));
      return respond(
        context,
        await getExaminationSessionTranscript(examinationSessionId.value, user.value, context.env),
      );
    },
  );
  app.all(
    "/:examinationSessionId/transcript",
    namedRoute("examination_transcript"),
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
    async (context) => {
      const examinationSessionId = getResourceId(context);
      if (!examinationSessionId.isOk())
        return respond(context, Result.err(examinationSessionId.error));
      const user = currentUser(context);
      if (!user.isOk()) return respond(context, Result.err(user.error));
      return respond(
        context,
        await getExaminationSession(
          examinationSessionId.value,
          user.value,
          context.env,
          context.get("dependencies"),
        ),
      );
    },
  );
  app.all(
    "/:examinationSessionId",
    namedRoute("examination_session"),
    examinationSessionIdParam,
    ...methodNotAllowed(["GET"]),
  );

  return app;
}
