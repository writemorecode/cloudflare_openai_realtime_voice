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
export class ConversationClientError extends Error {
  constructor(
    readonly code: ConversationClientErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ConversationClientError";
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
