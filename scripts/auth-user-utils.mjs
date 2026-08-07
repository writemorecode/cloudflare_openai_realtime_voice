import { spawn } from "node:child_process";
import { pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { Result } from "better-result";

const derive = promisify(pbkdf2);

export function parseUserArguments(argv) {
  const args = [...argv];
  while (args[0] === "--") args.shift();
  const location = args[0] === "--local" || args[0] === "--remote" ? args.shift() : "--remote";
  const database = args.length > 1 ? args.shift() : "oral-exam-auth";
  const username = args.shift();

  if (username === undefined || username.length === 0 || username.length > 64 || args.length > 0) {
    return Result.err(new Error("invalid user command arguments"));
  }
  return Result.ok({ location, database, username });
}

export async function readPassword(prompt = "Password: ") {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return stripTrailingLineEndings(Buffer.concat(chunks).toString("utf8"));
  }

  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  return new Promise((resolve) => {
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") process.exit(130);
        if (character === "\r" || character === "\n") {
          process.stdin.off("data", onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

export function stripTrailingLineEndings(value) {
  return value.replace(/[\r\n]+$/, "");
}

export async function hashPassword(password) {
  if (password.length < 12 || password.length > 256) {
    return Result.err(new Error("Password must contain 12 to 256 characters."));
  }
  // Keep this synchronized with PASSWORD_HASH_ITERATIONS in browser-auth.ts.
  const iterations = 100_000;
  const salt = randomBytes(16);
  const digest = await derive(password, salt, iterations, 32, "sha256");
  return Result.ok(["pbkdf2_sha256", iterations, base64Url(salt), base64Url(digest)].join("$"));
}

export function quoteSql(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function executeD1({ database, location, sql, json = false }) {
  const stdout = [];
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      database,
      location,
      "--command",
      sql,
      ...(json ? ["--json"] : []),
    ],
    {
      stdio: ["inherit", json ? "pipe" : "inherit", "inherit"],
      env: { ...process.env, WRANGLER_LOG_PATH: "/tmp/wrangler-auth.log" },
    },
  );
  if (json) child.stdout.on("data", (chunk) => stdout.push(chunk));

  const exitCode = await Result.tryPromise({
    try: () =>
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      }),
    catch: (error) => error,
  });
  if (!exitCode.isOk()) return exitCode;
  if (exitCode.value !== 0)
    return Result.err(new Error(`Wrangler exited with status ${exitCode.value}.`));
  if (!json) return Result.ok(undefined);

  return Result.try({
    try: () => JSON.parse(Buffer.concat(stdout).toString("utf8")),
    catch: (error) => error,
  });
}

export function firstStatementRows(output) {
  if (!Array.isArray(output)) return null;
  const first = output[0];
  if (typeof first !== "object" || first === null) return null;
  const results = first.results;
  return Array.isArray(results) ? results : null;
}

function base64Url(value) {
  return value.toString("base64url");
}
