/** Validates browser origins and builds CORS headers for the public HTTP API. */
import { ApiError } from "./api-errors";
import { err, ok, type Result } from "../try-catch";

export const CORS_ALLOWED_HEADERS = "Content-Type, Idempotency-Key";

export function validateOrigin(
  request: Request,
  allowedOrigin: string,
): Result<string | null, ApiError> {
  const origin = request.headers.get("Origin");
  if (origin === null) return ok(null);

  const configuredUrl = parseOrigin(allowedOrigin);
  if (configuredUrl === null) {
    return err(
      new ApiError(500, "cors_not_configured", "The API origin policy is not configured."),
    );
  }

  const requestUrl = parseOrigin(origin);
  if (requestUrl === null || requestUrl.origin !== configuredUrl.origin) {
    return err(new ApiError(403, "origin_not_allowed", "The request origin is not allowed."));
  }
  return ok(origin);
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

export function withCors(response: Response, origin: string | null): Response {
  if (origin === null) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", appendVary(headers.get("Vary"), "Origin"));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function preflightResponse(origin: string, methods: readonly string[]): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": methods.join(", "),
      "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}

function appendVary(current: string | null, value: string): string {
  return current === null ? value : `${current}, ${value}`;
}
