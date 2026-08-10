import { env } from "cloudflare:workers";
import { expect } from "vitest";

import { SESSION_COOKIE_NAME } from "../src/worker/http/browser-auth";

const encoder = new TextEncoder();
let cachedCookie: Promise<string> | undefined;

export function testSessionCookie(): Promise<string> {
  cachedCookie ??= createSessionCookie();
  return cachedCookie;
}

export async function authenticatedHeaders(extra: HeadersInit = {}): Promise<Headers> {
  return new Headers({
    Cookie: await testSessionCookie(),
    ...Object.fromEntries(new Headers(extra)),
  });
}

async function createSessionCookie(): Promise<string> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of tokenBytes) binary += String.fromCharCode(byte);
  const token = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
  let digestBinary = "";
  for (const byte of digest) digestBinary += String.fromCharCode(byte);
  const tokenHash = btoa(digestBinary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const user = await env.EXAM_DB.prepare("SELECT id FROM users WHERE username = ?")
    .bind("examiner")
    .first<{ id: number }>();
  if (user === null) {
    expect.fail("test user is missing");
  }
  const now = Date.now();
  await env.EXAM_DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(tokenHash, user.id, now, now + 86_400_000)
    .run();
  return `${SESSION_COOKIE_NAME}=${token}`;
}
