import { Result } from "better-result";
import { z } from "zod";

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
type DiagnosticField = (typeof DIAGNOSTIC_FIELDS)[number];

interface ErrorSource {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
  readonly code?: unknown;
  readonly kind?: unknown;
  readonly status?: unknown;
  readonly operation?: unknown;
  readonly reason?: unknown;
  readonly retryable?: unknown;
  readonly schemaVersion?: unknown;
}

interface ParsedErrorSource {
  readonly identity: object;
  readonly fields: ErrorSource;
}

const errorSourceSchema = z.object({
  name: z.unknown().optional(),
  message: z.unknown().optional(),
  cause: z.unknown().optional(),
  code: z.unknown().optional(),
  kind: z.unknown().optional(),
  status: z.unknown().optional(),
  operation: z.unknown().optional(),
  reason: z.unknown().optional(),
  retryable: z.unknown().optional(),
  schemaVersion: z.unknown().optional(),
});
const diagnosticValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const objectIdentitySchema = z.custom<object>((candidate) => Object(candidate) === candidate);

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

/** Converts a failure into bounded, searchable, non-secret diagnostic data. */
export function observableError<T>(value: T): ObservableError {
  return observe(value, 0, new WeakSet<object>());
}

function observe<T>(value: T, depth: number, ancestors: WeakSet<object>): ObservableError {
  const source = parseErrorSource(value);
  if (source === null) return primitiveError(value);
  if (ancestors.has(source.identity)) {
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

  ancestors.add(source.identity);
  const observed: ObservableError = {
    name: errorName(source.fields),
    message: errorMessage(source.fields),
    stack: value instanceof Error ? truncate(value.stack ?? "", MAX_STACK_LENGTH) || null : null,
    ...diagnosticFields(source.fields),
  };
  const cause = source.fields.cause;
  const result =
    cause === undefined ? observed : { ...observed, cause: observe(cause, depth + 1, ancestors) };
  ancestors.delete(source.identity);
  return result;
}

function primitiveError<T>(value: T): ObservableError {
  const stringValue = z.string().safeParse(value);
  return {
    name: "NonErrorThrown",
    message: stringValue.success
      ? truncate(stringValue.data, MAX_MESSAGE_LENGTH)
      : "A non-Error value was thrown.",
    stack: null,
    valueType: valueType(value),
  };
}

function errorName(value: ErrorSource): string {
  const name = parseString(value.name);
  if (name !== null) return truncate(name, MAX_MESSAGE_LENGTH);
  const kind = parseString(value.kind);
  if (kind !== null) return "StructuredError";
  const code = parseString(value.code);
  return code === null ? "UnknownError" : "StructuredError";
}

function errorMessage(value: ErrorSource): string {
  const message = parseString(value.message);
  return message === null
    ? "An error object without a message was returned."
    : truncate(message, MAX_MESSAGE_LENGTH);
}

function diagnosticFields(value: ErrorSource): Partial<ObservableError> {
  const fields: Partial<Record<DiagnosticField, DiagnosticValue>> = {};
  for (const field of DIAGNOSTIC_FIELDS) {
    const candidate = diagnosticValueSchema.safeParse(value[field]);
    if (!candidate.success) continue;
    const stringCandidate = z.string().safeParse(candidate.data);
    fields[field] = stringCandidate.success
      ? truncate(stringCandidate.data, MAX_MESSAGE_LENGTH)
      : candidate.data;
  }
  return fields;
}

function parseString<T>(value: T): string | null {
  const parsed = z.string().min(1).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseErrorSource<T>(value: T): ParsedErrorSource | null {
  const parsed = Result.try({
    try: () => ({
      identity: objectIdentitySchema.safeParse(value),
      fields: errorSourceSchema.safeParse(value),
    }),
    catch: () => undefined,
  });
  if (!parsed.isOk() || parsed.value === undefined) return null;
  return parsed.value.identity.success && parsed.value.fields.success
    ? { identity: parsed.value.identity.data, fields: parsed.value.fields.data }
    : null;
}

function valueType<T>(value: T): string {
  if (value === null) return "null";
  return Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}
