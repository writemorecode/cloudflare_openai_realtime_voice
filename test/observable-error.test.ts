import { describe, expect, it } from "vitest";

import { observableError } from "../src/shared/observable-error";
import { ApiError } from "../src/worker/http/api-errors";

describe("observableError", () => {
  it("preserves native and structured cause details", () => {
    const underlying = new Error("D1 constraint failed");
    const repositoryError = {
      code: "database_operation_failed",
      message: "Unable to complete the examination question.",
      cause: underlying,
    };
    const apiError = new ApiError(
      500,
      "examination_operation_failed",
      "The examination operation could not be completed.",
      {},
      repositoryError,
      { operation: "complete_current_examination_question" },
    );

    expect(observableError(apiError)).toMatchObject({
      name: "ApiError",
      code: "examination_operation_failed",
      status: 500,
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
    interface CircularFailure {
      kind: string;
      cause?: CircularFailure;
    }
    const failure: CircularFailure = { kind: "runtime_failure" };
    failure.cause = failure;

    expect(observableError(failure).cause).toMatchObject({
      name: "CircularErrorCause",
      circular: true,
    });
  });
});
