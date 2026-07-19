export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly headers: Readonly<Record<string, string>> = {},
    cause?: unknown,
  ) {
    super(title, { cause });
    this.name = "ApiError";
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
