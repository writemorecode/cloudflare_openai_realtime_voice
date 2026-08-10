import { Result, type Result as ResultValue } from "better-result";
import { z } from "zod";

/** Clone-safe Result envelope used by the Durable Object RPC boundary. */
export type ResultWire<T, E> =
  | Readonly<{ status: "ok"; value: T }>
  | Readonly<{ status: "error"; error: E }>;

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
  return resultCodec.serializeUnsafe(result) as ResultWire<T, E>;
}

/** Reconstructs a result from a value received across the RPC boundary. */
export function deserializeResult<T, E>(value: unknown): ResultValue<T, E> {
  return resultCodec.deserializeUnsafe(value) as ResultValue<T, E>;
}

/** Recursively replaces Error instances with their enumerable, clone-safe data. */
function toWireValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.cause === undefined ? {} : { cause: toWireValue(value.cause) }),
      ...Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "cause")
          .map(([key, entry]) => [key, toWireValue(entry)]),
      ),
    };
  }
  if (Array.isArray(value)) return value.map(toWireValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toWireValue(entry)]),
    );
  }
  return value;
}
