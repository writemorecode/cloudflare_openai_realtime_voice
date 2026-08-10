import { TaggedError } from "better-result";

/** Stable machine-readable codes returned by the conversation browser client. */
export type ConversationClientErrorCode =
  | "connection_not_ready"
  | "control_connection_failed"
  | "control_connection_closed"
  | "http_request_failed"
  | "invalid_response"
  | "media_operation_failed"
  | "realtime_operation_failed"
  | "recording_upload_failed"
  | "request_failed"
  | "shutdown_timeout"
  | "wire_protocol_error";

/** A stable error value returned by the browser conversation client. */
const ConversationClientErrorBase = TaggedError("ConversationClientError");

export class ConversationClientError extends ConversationClientErrorBase<{
  readonly code: ConversationClientErrorCode;
  readonly cause: unknown;
  readonly message: string;
}> {
  /** Creates a browser-client error with a stable code and optional underlying cause. */
  constructor(code: ConversationClientErrorCode, message: string, cause?: unknown) {
    super({ code, message, cause });
  }
}

/** Returns an existing client error or wraps an unknown failure in a new client error. */
export function conversationClientError(
  code: ConversationClientErrorCode,
  message: string,
  cause: unknown,
): ConversationClientError {
  return cause instanceof ConversationClientError
    ? cause
    : new ConversationClientError(code, message, cause);
}
