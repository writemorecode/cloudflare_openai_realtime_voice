const MAX_ERROR_DEPTH = 5;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_STACK_LENGTH = 12_000;

const DIAGNOSTIC_FIELDS = [
  "code",
  "kind",
  "status",
  "operation",
  "reason",
  "retryable",
  "schemaVersion",
] as const;

type DiagnosticValue = string | number | boolean | null;

export interface ObservableError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
  readonly cause?: ObservableError;
  readonly circular?: boolean;
  readonly depthLimited?: boolean;
  readonly valueType?: string;
  readonly code?: DiagnosticValue;
  readonly kind?: DiagnosticValue;
  readonly status?: DiagnosticValue;
  readonly operation?: DiagnosticValue;
  readonly reason?: DiagnosticValue;
  readonly retryable?: DiagnosticValue;
  readonly schemaVersion?: DiagnosticValue;
}

/** Converts an unknown failure into bounded, searchable, non-secret diagnostic data. */
export function observableError(value: unknown): ObservableError {
  return observe(value, 0, new WeakSet<object>());
}

function observe(value: unknown, depth: number, ancestors: WeakSet<object>): ObservableError {
  if (!isObject(value)) return primitiveError(value);
  if (ancestors.has(value)) {
    return {
      name: "CircularErrorCause",
      message: "The error cause chain contains a circular reference.",
      stack: null,
      circular: true,
    };
  }
  if (depth >= MAX_ERROR_DEPTH) {
    return {
      name: "ErrorCauseDepthLimit",
      message: "The error cause chain exceeded the observation depth limit.",
      stack: null,
      depthLimited: true,
    };
  }

  ancestors.add(value);
  const observed: ObservableError = {
    name: errorName(value),
    message: errorMessage(value),
    stack: value instanceof Error ? truncate(value.stack ?? "", MAX_STACK_LENGTH) || null : null,
    ...diagnosticFields(value),
  };
  const cause = readProperty(value, "cause");
  const result =
    cause === undefined ? observed : { ...observed, cause: observe(cause, depth + 1, ancestors) };
  ancestors.delete(value);
  return result;
}

function primitiveError(value: unknown): ObservableError {
  return {
    name: "NonErrorThrown",
    message:
      typeof value === "string"
        ? truncate(value, MAX_MESSAGE_LENGTH)
        : "A non-Error value was thrown.",
    stack: null,
    valueType: value === null ? "null" : typeof value,
  };
}

function errorName(value: object): string {
  const name = readString(value, "name");
  if (name !== null) return truncate(name, MAX_MESSAGE_LENGTH);
  const kind = readString(value, "kind");
  if (kind !== null) return "StructuredError";
  const code = readString(value, "code");
  return code === null ? "UnknownError" : "StructuredError";
}

function errorMessage(value: object): string {
  const message = readString(value, "message");
  return message === null
    ? "An error object without a message was returned."
    : truncate(message, MAX_MESSAGE_LENGTH);
}

function diagnosticFields(value: object): Partial<ObservableError> {
  const fields: Record<string, DiagnosticValue> = {};
  for (const field of DIAGNOSTIC_FIELDS) {
    const candidate = readProperty(value, field);
    if (
      candidate === null ||
      typeof candidate === "number" ||
      typeof candidate === "boolean" ||
      typeof candidate === "string"
    ) {
      fields[field] =
        typeof candidate === "string" ? truncate(candidate, MAX_MESSAGE_LENGTH) : candidate;
    }
  }
  return fields;
}

function readString(value: object, property: string): string | null {
  const candidate = readProperty(value, property);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function readProperty(value: object, property: string): unknown {
  const read = Result.try({
    try: () => Reflect.get(value, property) as unknown,
    catch: () => undefined,
  });
  return read.isOk() ? read.value : undefined;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}
import { Result } from "better-result";
