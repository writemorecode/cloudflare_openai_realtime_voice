import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyPassword } from "../src/worker/http/browser-auth";
import { missingRequiredApiBindings } from "../src/worker/http/hono-api";

const API_ORIGIN = "https://api.example.test";
const BROWSER_ORIGIN = "http://localhost:5173";

async function login(username: string, password: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`${API_ORIGIN}/v1/auth/login`, {
      method: "POST",
      headers: { Origin: BROWSER_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser authentication", () => {
  it("reports absent configuration without dereferencing missing bindings", () => {
    expect(
      missingRequiredApiBindings({
        ALLOWED_ORIGIN: BROWSER_ORIGIN,
        CONVERSATION_ID_SECRET: "configured",
      }),
    ).toEqual(["OPENAI_API_KEY"]);
  });

  it("verifies script-generated hashes without including terminal line endings", async () => {
    const encoded =
      "pbkdf2_sha256$100000$ABEiM0RVZneImaq7zN3u_w$9oIHRTR2PJCfUzwstKO7f-gw8RcJlgLsWRclYh47pLM";

    await expect(verifyPassword("Codex-Newline-Proof-2026!", encoded)).resolves.toEqual({
      status: "ok",
      value: true,
    });
    await expect(verifyPassword("Codex-Newline-Proof-2026!\n", encoded)).resolves.toEqual({
      status: "ok",
      value: false,
    });
    await expect(verifyPassword("Codex-Newline-Proof-2026!\r", encoded)).resolves.toEqual({
      status: "ok",
      value: false,
    });
    await expect(verifyPassword("Codex-Newline-Proof-2026!\r\n", encoded)).resolves.toEqual({
      status: "ok",
      value: false,
    });
    await expect(
      verifyPassword(
        "Codex-Newline-Proof-2026!",
        "pbkdf2_sha256$600000$ZFUEM7VvfvBmkPum5nqflA$3kHfqHaBMEgRSOUhOPPr-pF5aA5OLaCDwOmVXzq0JJ8",
      ),
    ).resolves.toEqual({ status: "ok", value: false });
  });

  it("rejects invalid credentials without identifying the missing user", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await login("missing-user", "incorrect-password");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "invalid_credentials",
      title: "The username or password is incorrect.",
    });
    expect(response.headers.get("Set-Cookie")).toBeNull();

    expect(errorLog).toHaveBeenCalledTimes(1);
    const entry = errorLog.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      kind: "conversation_http_error",
      method: "POST",
      path: "/v1/auth/login",
      route: "login",
      status: 401,
      code: "invalid_credentials",
      component: "browser_auth",
      operation: "login",
    });
    expect(JSON.stringify(entry)).not.toContain("missing-user");
    expect(JSON.stringify(entry)).not.toContain("incorrect-password");
  });

  it("preserves and logs the cause of a malformed login request", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/auth/login`, {
        method: "POST",
        headers: { Origin: BROWSER_ORIGIN, "Content-Type": "application/json" },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_login_request",
      title: "The login request is invalid.",
    });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]?.[0]).toMatchObject({
      kind: "conversation_http_error",
      route: "login",
      code: "invalid_login_request",
      component: "browser_auth",
      operation: "read_login_request_body",
      error: {
        name: "ApiError",
        cause: { name: "SyntaxError" },
      },
    });
  });

  it("creates, validates, and revokes an opaque cookie session", async () => {
    const response = await login("examiner", "correct horse battery staple");
    const setCookie = response.headers.get("Set-Cookie");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ username: "examiner" });
    expect(setCookie).toContain("__Host-oral_exam_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("correct horse battery staple");

    const cookie = setCookie?.split(";", 1)[0];
    expect(cookie).toBeDefined();
    const session = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/auth/session`, { headers: { Cookie: cookie! } }),
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ username: "examiner" });

    const logout = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/auth/logout`, {
        method: "POST",
        headers: { Cookie: cookie!, Origin: BROWSER_ORIGIN },
      }),
    );
    expect(logout.status).toBe(204);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");

    const revoked = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/auth/session`, { headers: { Cookie: cookie! } }),
    );
    expect(revoked.status).toBe(401);
  });
});
