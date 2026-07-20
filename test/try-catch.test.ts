import { describe, expect, it } from "vitest";

import { err, ok, tryCatch, type Result } from "../src/worker/try-catch";

describe("Result", () => {
  it("constructs typed success and failure variants", () => {
    const success: Result<number, string> = ok(42);
    const failure: Result<number, string> = err("failed");

    expect(success).toEqual({ ok: true, value: 42 });
    expect(failure).toEqual({ ok: false, error: "failed" });
  });
});

describe("tryCatch", () => {
  it("captures synchronous throws", async () => {
    const result = await tryCatch(
      () => {
        throw new TypeError("invalid input");
      },
      (cause) => (cause instanceof Error ? cause.name : "unknown"),
    );

    expect(result).toEqual({ ok: false, error: "TypeError" });
  });

  it("captures Promise rejections", async () => {
    const result = await tryCatch(
      () => Promise.reject(new Error("provider failed")),
      (cause) => (cause instanceof Error ? cause.message : "unknown"),
    );

    expect(result).toEqual({ ok: false, error: "provider failed" });
  });

  it("returns awaited success values", async () => {
    const result = await tryCatch(() => Promise.resolve(42), String);

    expect(result).toEqual({ ok: true, value: 42 });
  });
});
