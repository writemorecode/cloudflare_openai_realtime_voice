import { describe, expect, it } from "vitest";

import { deserializeResult, serializeResult } from "@ai-oral-exam/conversation-contract";
import { Result } from "better-result";

describe("Result", () => {
  it("constructs typed success and failure variants", () => {
    const success: Result<number, string> = Result.ok(42);
    const failure: Result<number, string> = Result.err("failed");

    expect(success).toMatchObject({ status: "ok", value: 42 });
    expect(failure).toMatchObject({ status: "error", error: "failed" });
  });
});

describe("better-result exception capture", () => {
  it("captures synchronous throws without changing the calling API to async", () => {
    const result = Result.try({
      try: () => {
        throw new TypeError("invalid input");
      },
      catch: (cause) => (cause instanceof Error ? cause.name : "unknown"),
    });

    expect(result).toMatchObject({ status: "error", error: "TypeError" });
  });

  it("captures synchronous throws", async () => {
    const result = await Result.tryPromise({
      try: () => {
        throw new TypeError("invalid input");
      },
      catch: (cause) => (cause instanceof Error ? cause.name : "unknown"),
    });

    expect(result).toMatchObject({ status: "error", error: "TypeError" });
  });

  it("captures Promise rejections", async () => {
    const result = await Result.tryPromise({
      try: () => Promise.reject(new Error("provider failed")),
      catch: (cause) => (cause instanceof Error ? cause.message : "unknown"),
    });

    expect(result).toMatchObject({ status: "error", error: "provider failed" });
  });

  it("returns awaited success values", async () => {
    const result = await Result.tryPromise({
      try: () => Promise.resolve(42),
      catch: String,
    });

    expect(result).toMatchObject({ status: "ok", value: 42 });
  });

  it("round-trips a Result through the Durable Object wire codec", () => {
    const encoded = serializeResult(Result.err(new Error("provider failed")));
    const decoded = deserializeResult<never, { name: string; message: string }>(encoded);

    expect(encoded).toEqual({
      status: "error",
      error: { name: "Error", message: "provider failed" },
    });
    expect(decoded).toMatchObject({
      status: "error",
      error: { name: "Error", message: "provider failed" },
    });
  });
});
