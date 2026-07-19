/** Enforces HTTP authentication, idempotency, and request-integrity safeguards. */
import { ApiError } from "./api-errors";

const encoder = new TextEncoder();

export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export function authenticateBearer(request: Request, expectedToken: string): void {
  const authorization = request.headers.get("Authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    throw unauthorized();
  }

  const suppliedToken = authorization.slice("Bearer ".length);
  const supplied = encoder.encode(suppliedToken);
  const expected = encoder.encode(expectedToken);
  if (
    supplied.byteLength !== expected.byteLength ||
    !crypto.subtle.timingSafeEqual(supplied, expected)
  ) {
    throw unauthorized();
  }
}

export function validateIdempotencyKey(value: string | null): string {
  if (
    value === null ||
    value.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    value.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new ApiError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must contain 8 to 128 printable ASCII characters.",
    );
  }
  return value;
}

export async function deriveConversationId(
  secret: string,
  idempotencyKey: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`conversation:v1:${idempotencyKey}`)),
  );

  // RFC 9562 variant and version 8 (application-defined) identifier.
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function unauthorized(): ApiError {
  return new ApiError(401, "unauthorized", "A valid bearer token is required.", {
    "WWW-Authenticate": "Bearer",
  });
}
