/** Normalizes API failures into sanitized RFC 7807-style HTTP problem responses. */
import { TaggedError } from "better-result";

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
}

export type ApiErrorTelemetryValue = string | number | boolean | null;
export type ApiErrorTelemetry = Readonly<Record<string, ApiErrorTelemetryValue>>;

const ApiErrorBase = TaggedError("ApiError");

export class ApiError extends ApiErrorBase<{
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly cause: unknown;
  readonly telemetry: ApiErrorTelemetry;
  readonly message: string;
}> {
  constructor(
    status: number,
    code: string,
    title: string,
    headers: Readonly<Record<string, string>> = {},
    cause?: unknown,
    telemetry: ApiErrorTelemetry = {},
  ) {
    super({ status, code, title, headers, cause, telemetry, message: title });
  }
}

export function problemResponse(error: ApiError, requestId: string): Response {
  const body: ProblemDetails = {
    type: `https://oai-cf-realtime.invalid/problems/${error.code}`,
    title: error.title,
    status: error.status,
    code: error.code,
    requestId,
  };

  return Response.json(body, {
    status: error.status,
    headers: {
      "Content-Type": "application/problem+json",
      ...error.headers,
    },
  });
}
