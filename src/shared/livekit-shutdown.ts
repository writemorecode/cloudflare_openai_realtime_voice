export const LIVEKIT_SHUTDOWN_MESSAGE_VERSION = 1 as const;

export interface LiveKitShutdownMessage {
  readonly version: typeof LIVEKIT_SHUTDOWN_MESSAGE_VERSION;
  readonly conversationId: string;
  readonly triggerEventId: string;
}

export function isLiveKitShutdownMessage(value: unknown): value is LiveKitShutdownMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.version === LIVEKIT_SHUTDOWN_MESSAGE_VERSION &&
    typeof message.conversationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      message.conversationId,
    ) &&
    typeof message.triggerEventId === "string" &&
    message.triggerEventId.length > 0 &&
    message.triggerEventId.length <= 128
  );
}
