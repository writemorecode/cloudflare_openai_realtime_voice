import { TaggedError } from "better-result";

export type ConversationClientErrorCode =
  | "connection_not_ready"
  | "control_connection_failed"
  | "control_connection_closed"
  | "http_request_failed"
  | "invalid_response"
  | "livekit_operation_failed"
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
  constructor(code: ConversationClientErrorCode, message: string, cause?: unknown) {
    super({ code, message, cause });
  }
}

export function conversationClientError(
  code: ConversationClientErrorCode,
  message: string,
  cause: unknown,
): ConversationClientError {
  return cause instanceof ConversationClientError
    ? cause
    : new ConversationClientError(code, message, cause);
}
