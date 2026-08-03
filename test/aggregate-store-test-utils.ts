export function aggregateValue<T>(result: unknown): T {
  if (typeof result !== "object" || result === null || !("status" in result)) {
    throw new Error("expected aggregate Result");
  }
  if (result.status !== "ok") {
    throw new Error("aggregate operation failed");
  }
  if (!("value" in result)) {
    throw new Error("aggregate Result omitted its value");
  }
  return result.value as T;
}
