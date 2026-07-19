import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { verifyPassword } from "../src/worker/http/browser-auth";

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

describe("browser authentication", () => {
  it("verifies script-generated hashes without including terminal line endings", async () => {
    const encoded =
      "pbkdf2_sha256$100000$ABEiM0RVZneImaq7zN3u_w$9oIHRTR2PJCfUzwstKO7f-gw8RcJlgLsWRclYh47pLM";

    await expect(verifyPassword("Codex-Newline-Proof-2026!", encoded)).resolves.toBe(true);
    await expect(verifyPassword("Codex-Newline-Proof-2026!\n", encoded)).resolves.toBe(false);
    await expect(verifyPassword("Codex-Newline-Proof-2026!\r", encoded)).resolves.toBe(false);
    await expect(verifyPassword("Codex-Newline-Proof-2026!\r\n", encoded)).resolves.toBe(false);
    await expect(
      verifyPassword(
        "Codex-Newline-Proof-2026!",
        "pbkdf2_sha256$600000$ZFUEM7VvfvBmkPum5nqflA$3kHfqHaBMEgRSOUhOPPr-pF5aA5OLaCDwOmVXzq0JJ8",
      ),
    ).resolves.toBe(false);
  });

  it("rejects invalid credentials without identifying the missing user", async () => {
    const response = await login("missing-user", "incorrect-password");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "invalid_credentials",
      title: "The username or password is incorrect.",
    });
    expect(response.headers.get("Set-Cookie")).toBeNull();
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
