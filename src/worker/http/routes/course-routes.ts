import { Result } from "better-result";
import { createCourse, getCourse, getCourses } from "../../courses/course-api";
import { createExamination } from "../../examinations/examination-api";
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

const courseIdParam = resourceIdParam(
  "courseId",
  "invalid_course_id",
  "Course ID must be a canonical UUID.",
);

export function createCourseRoutes() {
  const app = apiFactory.createApp();
  app.use("*", validateSmallHeaders);
  app.options("/", namedRoute("courses"), ...preflight(["GET", "POST"]));
  app.get("/", namedRoute("courses"), requireBrowserSession, requireEmptyBody, async (context) =>
    respond(context, await getCourses(context.env)),
  );
  app.post(
    "/",
    namedRoute("courses"),
    requireBrowserOrigin,
    requireBrowserSession,
    async (context) => {
      const user = currentUser(context);
      if (!user.isOk()) return respond(context, Result.err(user.error));
      return respond(
        context,
        await createCourse(context.req.raw, user.value, context.env, context.get("dependencies")),
      );
    },
  );
  app.all("/", namedRoute("courses"), ...methodNotAllowed(["GET", "POST"]));

  app.options("/:courseId/examinations", namedRoute("course_examinations"), ...preflight(["POST"]));
  app.post(
    "/:courseId/examinations",
    namedRoute("course_examinations"),
    courseIdParam,
    requireBrowserOrigin,
    requireBrowserSession,
    async (context) => {
      const courseId = getResourceId(context);
      if (!courseId.isOk()) return respond(context, Result.err(courseId.error));
      const user = currentUser(context);
      if (!user.isOk()) return respond(context, Result.err(user.error));
      return respond(
        context,
        await createExamination(
          context.req.raw,
          courseId.value,
          user.value,
          context.env,
          context.get("dependencies"),
        ),
      );
    },
  );
  app.all(
    "/:courseId/examinations",
    namedRoute("course_examinations"),
    courseIdParam,
    ...methodNotAllowed(["POST"]),
  );

  app.options("/:courseId", namedRoute("course"), ...preflight(["GET"]));
  app.get(
    "/:courseId",
    namedRoute("course"),
    courseIdParam,
    requireBrowserSession,
    requireEmptyBody,
    async (context) => {
      const id = getResourceId(context);
      return id.isOk()
        ? respond(context, await getCourse(id.value, context.env))
        : respond(context, Result.err(id.error));
    },
  );
  app.all("/:courseId", namedRoute("course"), courseIdParam, ...methodNotAllowed(["GET"]));
  return app;
}
