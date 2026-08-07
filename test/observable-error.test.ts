import { describe, expect, it } from "vitest";

import { observableError } from "../src/shared/observable-error";

describe("observableError", () => {
  it("preserves native and structured cause details", () => {
    const underlying = new Error("D1 constraint failed");
    const repositoryError = {
      code: "database_operation_failed",
      message: "Unable to complete the examination question.",
      cause: underlying,
    };
    const apiError = new Error("The examination operation could not be completed.", {
      cause: repositoryError,
    });

    expect(observableError(apiError)).toMatchObject({
      name: "Error",
      message: "The examination operation could not be completed.",
      cause: {
        name: "StructuredError",
        code: "database_operation_failed",
        message: "Unable to complete the examination question.",
        cause: { name: "Error", message: "D1 constraint failed" },
      },
    });
  });

  it("allowlists diagnostics without copying arbitrary fields", () => {
    const observed = observableError({
      kind: "runtime_failure",
      operation: "flush_shutdown_outbox",
      secret: "must-not-be-logged",
      requestBody: { password: "also-secret" },
      cause: "provider unavailable",
    });

    expect(observed).toMatchObject({
      name: "StructuredError",
      kind: "runtime_failure",
      operation: "flush_shutdown_outbox",
      cause: {
        name: "NonErrorThrown",
        message: "provider unavailable",
        valueType: "string",
      },
    });
    expect(observed).not.toHaveProperty("secret");
    expect(observed).not.toHaveProperty("requestBody");
  });

  it("bounds circular cause chains", () => {
    const failure: { kind: string; cause?: unknown } = { kind: "runtime_failure" };
    failure.cause = failure;

    expect(observableError(failure).cause).toMatchObject({
      name: "CircularErrorCause",
      circular: true,
    });
  });
});
