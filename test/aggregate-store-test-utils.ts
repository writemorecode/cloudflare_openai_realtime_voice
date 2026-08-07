import { expect } from "vitest";

export function aggregateValue<T>(result: unknown): T {
  if (typeof result !== "object" || result === null || !("status" in result)) {
    expect.fail("expected aggregate Result");
  }
  if (result.status !== "ok") {
    expect.fail("aggregate operation failed");
  }
  if (!("value" in result)) {
    expect.fail("aggregate Result omitted its value");
  }
  return result.value as T;
}
