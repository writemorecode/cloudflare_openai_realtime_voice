import { Result, type Result as ResultValue } from "better-result";
import { z } from "zod";

/** Clone-safe Result envelope used by the Durable Object RPC boundary. */
export type ResultWire<T, E> =
  | Readonly<{ status: "ok"; value: T }>
  | Readonly<{ status: "error"; error: E }>;

interface WireObject {
  [key: string]: WireValue;
}

type WireValue = string | number | boolean | bigint | null | undefined | WireValue[] | WireObject;

const wirePrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.bigint(),
  z.null(),
  z.undefined(),
]);
const wireObjectInputSchema = z.record(z.string(), z.unknown());

/** Serializes result values while recursively converting errors into clone-safe data. */
const resultCodec = Result.codec({
  serialize: {
    ok: z.unknown(),
    err: z.unknown().transform(toWireValue),
  },
  deserialize: {
    ok: z.unknown(),
    err: z.unknown(),
  },
});

/** Converts a result to the structured-clone-safe representation used at the RPC boundary. */
export function serializeResult<T, E>(result: ResultValue<T, E>): ResultWire<T, E> {
  // SAFETY: the codec preserves the Result discriminant and only transforms the error payload.
  return resultCodec.serializeUnsafe(result) as ResultWire<T, E>;
}

/** Reconstructs a result from a value received across the RPC boundary. */
export function deserializeResult<T, E>(value: ResultWire<T, E>): ResultValue<T, E> {
  // SAFETY: callers supply the typed RPC envelope and the codec validates its discriminant.
  return resultCodec.deserializeUnsafe(value) as ResultValue<T, E>;
}

/** Recursively replaces Error instances with their enumerable, clone-safe data. */
function toWireValue<T>(value: T): WireValue {
  if (value instanceof Error) {
    const serialized: WireObject = {
      name: value.name,
      message: value.message,
    };
    if (value.cause !== undefined) serialized.cause = toWireValue(value.cause);
    for (const [key, entry] of Object.entries(value)) {
      if (key !== "cause") serialized[key] = toWireValue(entry);
    }
    return serialized;
  }
  if (Array.isArray(value)) return value.map(toWireValue);
  const objectInput = wireObjectInputSchema.safeParse(value);
  if (objectInput.success) {
    return Object.fromEntries(
      Object.entries(objectInput.data).map(([key, entry]) => [key, toWireValue(entry)]),
    );
  }
  const primitive = wirePrimitiveSchema.safeParse(value);
  return primitive.success ? primitive.data : String(value);
}
