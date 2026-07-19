import assert from "node:assert/strict";
import { pbkdf2 } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";

import {
  firstStatementRows,
  hashPassword,
  parseUserArguments,
  quoteSql,
  stripTrailingLineEndings,
} from "./auth-user-utils.mjs";

test("parses pnpm separators and explicit D1 location", () => {
  assert.deepEqual(parseUserArguments(["--", "--local", "custom-auth", "examiner"]), {
    location: "--local",
    database: "custom-auth",
    username: "examiner",
  });
});

test("defaults to the remote oral-exam database", () => {
  assert.deepEqual(parseUserArguments(["examiner"]), {
    location: "--remote",
    database: "oral-exam-auth",
    username: "examiner",
  });
});

test("rejects extra arguments", () => {
  assert.throws(() => parseUserArguments(["database", "username", "extra"]));
});

test("creates a verifiable salted password hash", async () => {
  const password = "correct horse battery staple";
  const encoded = await hashPassword(password);
  const [scheme, iterations, salt, expected] = encoded.split("$");
  assert.equal(scheme, "pbkdf2_sha256");
  assert.equal(iterations, "100000");
  const actual = await promisify(pbkdf2)(
    password,
    Buffer.from(salt, "base64url"),
    Number(iterations),
    32,
    "sha256",
  );
  assert.deepEqual(actual, Buffer.from(expected, "base64url"));
});

test("strips trailing line endings from piped passwords", () => {
  assert.equal(stripTrailingLineEndings("password without newline"), "password without newline");
  assert.equal(stripTrailingLineEndings("password with LF\n"), "password with LF");
  assert.equal(stripTrailingLineEndings("password with CR\r"), "password with CR");
  assert.equal(stripTrailingLineEndings("password with CRLF\r\n"), "password with CRLF");
  assert.equal(
    stripTrailingLineEndings("password with blank lines\r\n\n"),
    "password with blank lines",
  );
});

test("escapes SQL string literals", () => {
  assert.equal(quoteSql("user'name"), "'user''name'");
});

test("reads returned rows from Wrangler JSON", () => {
  assert.deepEqual(firstStatementRows([{ results: [{ id: 1 }], success: true }]), [{ id: 1 }]);
  assert.equal(firstStatementRows({ results: [] }), null);
});
