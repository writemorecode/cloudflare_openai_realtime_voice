/** An explicit success-or-failure value for operations that can fail. */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Captures a synchronous throw and maps it to an explicit error type. */
export function tryCatchSync<T, E>(
  operation: () => T,
  mapError: (cause: unknown) => E,
): Result<T, E> {
  try {
    return ok(operation());
  } catch (cause) {
    return err(mapError(cause));
  }
}

/** Captures synchronous throws and Promise rejections and maps them to an explicit error type. */
export async function tryCatch<T, E>(
  operation: () => T | PromiseLike<T>,
  mapError: (cause: unknown) => E,
): Promise<Result<Awaited<T>, E>> {
  try {
    return ok(await operation());
  } catch (cause) {
    return err(mapError(cause));
  }
}
