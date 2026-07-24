/** Processes retryable queue messages that clean up provisioned LiveKit conversation resources. */
import { ApiError } from "../../http/api-errors";
import type { Result } from "@ai-oral-exam/result";
import {
  isLiveKitShutdownMessage,
  type LiveKitShutdownMessage,
} from "../../../shared/livekit-shutdown";

const MAX_RETRY_DELAY_SECONDS = 60;

export type LiveKitStopOperation = (
  conversationId: string,
) => Promise<Result<"stopped" | "already_stopped", ApiError>>;

export async function handleLiveKitShutdownBatch(
  batch: MessageBatch<LiveKitShutdownMessage>,
  stop: LiveKitStopOperation,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      if (!isLiveKitShutdownMessage(message.body)) {
        console.error(
          JSON.stringify({
            kind: "livekit_shutdown_queue_invalid_message",
            messageId: message.id,
          }),
        );
        message.ack();
        return;
      }

      try {
        const outcome = await stop(message.body.conversationId);
        if (!outcome.ok) {
          if (outcome.error.code === "livekit_not_provisioned") {
            console.warn(
              JSON.stringify({
                kind: "livekit_shutdown_queue_not_provisioned",
                messageId: message.id,
                conversationId: message.body.conversationId,
              }),
            );
            message.ack();
            return;
          }
          retryMessage(message, outcome.error);
          return;
        }
        console.log(
          JSON.stringify({
            kind: "livekit_shutdown_queue_processed",
            messageId: message.id,
            conversationId: message.body.conversationId,
            triggerEventId: message.body.triggerEventId,
            outcome: outcome.value,
          }),
        );
        message.ack();
      } catch (error) {
        retryMessage(message, error);
      }
    }),
  );
}

function retryMessage(message: Message<LiveKitShutdownMessage>, error: unknown): void {
  const cause = error instanceof ApiError && error.cause !== undefined ? error.cause : error;
  const delaySeconds = Math.min(
    MAX_RETRY_DELAY_SECONDS,
    2 ** Math.max(0, message.attempts - 1) * 5,
  );
  console.error(
    JSON.stringify({
      kind: "livekit_shutdown_queue_retry",
      messageId: message.id,
      conversationId: message.body.conversationId,
      attempt: message.attempts,
      delaySeconds,
      error: cause instanceof Error ? cause.name : "unknown_error",
    }),
  );
  message.retry({ delaySeconds });
}
