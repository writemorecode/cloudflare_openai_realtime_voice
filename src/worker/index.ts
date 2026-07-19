/**
 * Cloudflare Worker deployment entrypoint.
 *
 * Wrangler loads this module for the stateless HTTP API and re-exports ConversationSession so the
 * same Cloudflare deployment can bind the stateful Durable Object class.
 */
import { ConversationSession } from "../durable-object/conversation-session";
import { conversationApi } from "./http/conversation-api";
import type { LiveKitShutdownMessage } from "../shared/livekit-shutdown";
import { handleLiveKitShutdownBatch } from "./integrations/livekit/shutdown-queue";

export { ConversationSession };
export default {
  fetch: conversationApi.fetch,
  queue: (batch, env) => handleLiveKitShutdownBatch(batch, env),
} satisfies ExportedHandler<Env, LiveKitShutdownMessage>;
