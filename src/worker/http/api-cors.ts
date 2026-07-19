import { ApiError } from "./api-errors";

export const CORS_ALLOWED_HEADERS = "Content-Type, Idempotency-Key";

export function validateOrigin(request: Request, allowedOrigin: string): string | null {
  const origin = request.headers.get("Origin");
  if (origin === null) return null;

  const configuredUrl = parseOrigin(allowedOrigin);
  if (configuredUrl === null) {
    throw new Error("ALLOWED_ORIGIN must be a valid HTTP(S) origin");
  }

  const requestUrl = parseOrigin(origin);
  if (requestUrl === null || requestUrl.origin !== configuredUrl.origin) {
    throw new ApiError(403, "origin_not_allowed", "The request origin is not allowed.");
  }
  return origin;
}

function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
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
  } catch {
    return null;
  }
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
