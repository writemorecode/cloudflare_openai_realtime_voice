/** Implements credential verification and signed browser-session handling at the HTTP boundary. */
import { pbkdf2Sync } from "node:crypto";

import { ApiError } from "./api-errors";
import { err, ok, tryCatch, type Result } from "../try-catch";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PASSWORD_COMPARISON_MESSAGE = encoder.encode("oral-exam-password-verification");

export const SESSION_COOKIE_NAME = "__Host-oral_exam_session";
// Deployed Workers reject higher PBKDF2 costs with NotSupportedError. Keep this
// synchronized with scripts/auth-user-utils.mjs.
export const PASSWORD_HASH_ITERATIONS = 100_000;

const PASSWORD_HASH_ALGORITHM = "pbkdf2_sha256";
const DUMMY_PASSWORD_HASH =
  "pbkdf2_sha256$100000$AAECAwQFBgcICQoLDA0ODw$SdScJfWXhGIJ8Nkud3CrZOHHXpS0zmxQkmXuZxddKh4";
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;
const SESSION_TOKEN_BYTES = 32;
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_LOGIN_BODY_BYTES = 4 * 1_024;
const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 256;

interface LoginCredentials {
  readonly username: string;
  readonly password: string;
}

export interface AuthenticatedUser {
  readonly id: number;
  readonly username: string;
}

interface SessionRow {
  readonly id: number;
  readonly username: string;
}

interface UserRow extends SessionRow {
  readonly password_hash: string;
}

interface AttemptRow {
  readonly window_started_at: number;
  readonly attempts: number;
}

export async function login(
  request: Request,
  database: D1Database,
): Promise<Result<Response, ApiError>> {
  const credentials = await readCredentials(request);
  if (!credentials.ok) return credentials;

  const operation = await tryCatch(async (): Promise<Result<Response, ApiError>> => {
    const now = Date.now();
    const attemptKey = await loginAttemptKey(request);
    const attempt = await database
      .prepare("SELECT window_started_at, attempts FROM login_attempts WHERE attempt_key = ?")
      .bind(attemptKey)
      .first<AttemptRow>();

    if (
      attempt !== null &&
      now - attempt.window_started_at < LOGIN_WINDOW_MS &&
      attempt.attempts >= MAX_LOGIN_ATTEMPTS
    ) {
      return err(
        new ApiError(429, "login_rate_limited", "Too many login attempts. Try again later.", {
          "Retry-After": String(
            Math.ceil((LOGIN_WINDOW_MS - (now - attempt.window_started_at)) / 1_000),
          ),
        }),
      );
    }

    const user = await database
      .prepare("SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE")
      .bind(credentials.value.username)
      .first<UserRow>();
    const valid = await verifyPassword(
      credentials.value.password,
      user?.password_hash ?? DUMMY_PASSWORD_HASH,
    );
    if (!valid.ok) return valid;

    if (!valid.value || user === null) {
      await recordFailedLogin(database, attemptKey, attempt, now);
      return err(invalidCredentials());
    }

    const token = randomBase64Url(SESSION_TOKEN_BYTES);
    const tokenHash = await sha256Base64Url(token);
    const expiresAt = now + SESSION_TTL_SECONDS * 1_000;
    await database.batch([
      database.prepare("DELETE FROM login_attempts WHERE attempt_key = ?").bind(attemptKey),
      database.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
      database.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      database
        .prepare(
          "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        )
        .bind(tokenHash, user.id, now, expiresAt),
    ]);

    return ok(
      Response.json(
        { username: user.username },
        {
          headers: {
            "Cache-Control": "no-store",
            "Set-Cookie": sessionCookie(token, SESSION_TTL_SECONDS),
          },
        },
      ),
    );
  }, authenticationOperationFailed);
  return operation.ok ? operation.value : operation;
}

export async function logout(
  request: Request,
  database: D1Database,
): Promise<Result<Response, ApiError>> {
  return tryCatch(async () => {
    const token = readSessionToken(request);
    if (token !== null) {
      await database
        .prepare("DELETE FROM sessions WHERE token_hash = ?")
        .bind(await sha256Base64Url(token))
        .run();
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": sessionCookie("", 0),
      },
    });
  }, authenticationOperationFailed);
}

export async function authenticateBrowserSession(
  request: Request,
  database: D1Database,
): Promise<Result<AuthenticatedUser, ApiError>> {
  const token = readSessionToken(request);
  if (token === null) return err(sessionUnauthorized());

  const row = await tryCatch(
    async () =>
      database
        .prepare(
          `SELECT users.id, users.username
           FROM sessions JOIN users ON users.id = sessions.user_id
           WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
        )
        .bind(await sha256Base64Url(token), Date.now())
        .first<SessionRow>(),
    authenticationOperationFailed,
  );
  if (!row.ok) return row;
  return row.value === null ? err(sessionUnauthorized()) : ok(row.value);
}

export async function hashPassword(password: string): Promise<Result<string, ApiError>> {
  return tryCatch(async () => {
    const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
    const derived = await derivePassword(password, salt, PASSWORD_HASH_ITERATIONS);
    return [
      PASSWORD_HASH_ALGORITHM,
      String(PASSWORD_HASH_ITERATIONS),
      encodeBase64Url(salt),
      encodeBase64Url(derived),
    ].join("$");
  }, authenticationOperationFailed);
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<Result<boolean, ApiError>> {
  const parts = encodedHash.split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_ALGORITHM) return ok(false);
  const iterations = Number(parts[1]);
  if (iterations !== PASSWORD_HASH_ITERATIONS) return ok(false);
  const salt = decodeBase64Url(parts[2] ?? "");
  const expected = decodeBase64Url(parts[3] ?? "");
  if (salt === null || expected === null) return ok(false);
  if (salt.byteLength !== PASSWORD_SALT_BYTES || expected.byteLength !== PASSWORD_HASH_BYTES) {
    return ok(false);
  }
  return tryCatch(
    async () => passwordDigestsEqual(await derivePassword(password, salt, iterations), expected),
    authenticationOperationFailed,
  );
}

async function readCredentials(request: Request): Promise<Result<LoginCredentials, ApiError>> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return err(
      new ApiError(415, "unsupported_media_type", "Login requests must use application/json."),
    );
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_LOGIN_BODY_BYTES) return err(loginBodyTooLarge());
  const body = await tryCatch(() => request.arrayBuffer(), authenticationOperationFailed);
  if (!body.ok) return body;
  const bytes = new Uint8Array(body.value);
  if (bytes.byteLength > MAX_LOGIN_BODY_BYTES) return err(loginBodyTooLarge());

  const parsed = await tryCatch(
    () => JSON.parse(decoder.decode(bytes)) as unknown,
    () => new ApiError(400, "invalid_login_request", "The login request is invalid."),
  );
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (typeof value !== "object" || value === null) return err(invalidLoginRequest());
  const record = value as Record<string, unknown>;
  if (
    typeof record.username !== "string" ||
    record.username.length === 0 ||
    record.username.length > MAX_USERNAME_LENGTH ||
    typeof record.password !== "string" ||
    record.password.length === 0 ||
    record.password.length > MAX_PASSWORD_LENGTH
  ) {
    return err(invalidLoginRequest());
  }
  return ok({ username: record.username, password: record.password });
}

async function derivePassword(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  return pbkdf2Sync(password, salt, iterations, PASSWORD_HASH_BYTES, "sha256");
}

async function passwordDigestsEqual(actual: Uint8Array, expected: Uint8Array): Promise<boolean> {
  const [actualKey, expectedKey] = await Promise.all([
    crypto.subtle.importKey("raw", actual, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    crypto.subtle.importKey("raw", expected, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
  ]);
  const signature = await crypto.subtle.sign("HMAC", actualKey, PASSWORD_COMPARISON_MESSAGE);
  return crypto.subtle.verify("HMAC", expectedKey, signature, PASSWORD_COMPARISON_MESSAGE);
}

async function recordFailedLogin(
  database: D1Database,
  attemptKey: string,
  current: AttemptRow | null,
  now: number,
): Promise<void> {
  const sameWindow = current !== null && now - current.window_started_at < LOGIN_WINDOW_MS;
  await database
    .prepare(
      `INSERT INTO login_attempts (attempt_key, window_started_at, attempts) VALUES (?, ?, ?)
       ON CONFLICT(attempt_key) DO UPDATE SET window_started_at = excluded.window_started_at,
       attempts = excluded.attempts`,
    )
    .bind(
      attemptKey,
      sameWindow ? current.window_started_at : now,
      sameWindow ? current.attempts + 1 : 1,
    )
    .run();
}

async function loginAttemptKey(request: Request): Promise<string> {
  const clientAddress = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return sha256Base64Url(clientAddress);
}

function readSessionToken(request: Request): string | null {
  for (const cookie of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      const token = value.join("=");
      return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
    }
  }
  return null;
}

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function randomBase64Url(byteLength: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256Base64Url(value: string): Promise<string> {
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(base64 + padding), (character) => character.charCodeAt(0));
}

function authenticationOperationFailed(cause: unknown): ApiError {
  return new ApiError(
    500,
    "authentication_operation_failed",
    "Authentication could not be completed.",
    {},
    cause,
  );
}

function invalidLoginRequest(): ApiError {
  return new ApiError(400, "invalid_login_request", "A username and password are required.");
}

function loginBodyTooLarge(): ApiError {
  return new ApiError(413, "login_request_too_large", "The login request is too large.");
}

function invalidCredentials(): ApiError {
  return new ApiError(401, "invalid_credentials", "The username or password is incorrect.");
}

function sessionUnauthorized(): ApiError {
  return new ApiError(401, "unauthorized", "A valid browser session is required.");
}
