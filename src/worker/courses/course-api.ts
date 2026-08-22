import { createCourseRequestSchema } from "@ai-oral-exam/conversation-contract";
import { Result } from "better-result";
import type { AuthenticatedUser } from "../http/browser-auth";
import { ApiError } from "../http/api-errors";
import type { FoundationDependencies } from "../ports/foundation";
import { findCourse, insertCourse, listCourses } from "./course-repository";

interface CourseApiResult {
  readonly response: Response;
  readonly conversationId: null;
  readonly outcome: string;
}
type ApiResult = Result<CourseApiResult, ApiError>;

export async function createCourse(
  request: Request,
  user: AuthenticatedUser,
  env: Env,
  dependencies: Pick<FoundationDependencies, "clock" | "ids">,
): Promise<ApiResult> {
  const body = await Result.tryPromise({
    try: () => request.json(),
    catch: () => new ApiError(400, "invalid_course_request", "Request body must be valid JSON."),
  });
  if (!body.isOk()) return body;
  const parsed = createCourseRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return Result.err(new ApiError(400, "invalid_course_request", "Course details are invalid."));
  const course = await Result.tryPromise({
    try: () =>
      insertCourse(env.EXAM_DB, {
        id: dependencies.ids.randomUuid(),
        userId: user.id,
        request: parsed.data,
        now: dependencies.clock.now(),
      }),
    catch: courseOperationFailed("Unable to create course."),
  });
  if (!course.isOk()) return course;
  return Result.ok({
    response: Response.json(course.value, { status: 201 }),
    conversationId: null,
    outcome: "course_created",
  });
}

export async function getCourses(env: Env): Promise<ApiResult> {
  const courses = await Result.tryPromise({
    try: () => listCourses(env.EXAM_DB),
    catch: courseOperationFailed("Unable to list courses."),
  });
  if (!courses.isOk()) return courses;
  return Result.ok({
    response: Response.json({ courses: courses.value }),
    conversationId: null,
    outcome: "courses_returned",
  });
}

export async function getCourse(id: string, env: Env): Promise<ApiResult> {
  const course = await Result.tryPromise({
    try: () => findCourse(env.EXAM_DB, id),
    catch: courseOperationFailed("Unable to retrieve course."),
  });
  if (!course.isOk()) return course;
  if (course.value === null)
    return Result.err(new ApiError(404, "course_not_found", "Course not found."));
  return Result.ok({
    response: Response.json(course.value),
    conversationId: null,
    outcome: "course_returned",
  });
}

function courseOperationFailed(message: string) {
  return <Cause>(cause: Cause) => new ApiError(500, "course_operation_failed", message, {}, cause);
}
