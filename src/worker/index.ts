/**
 * Cloudflare Worker deployment entrypoint.
 *
 * Wrangler loads this module for the stateless HTTP API and re-exports ConversationSession so the
 * same Cloudflare deployment can bind the stateful Durable Object class.
 */
import { ConversationSession } from "../durable-object/conversation-session";
import { handleConversationRequest } from "./http/conversation-api";
import type { LiveKitShutdownMessage } from "../shared/livekit-shutdown";
import { foundationDependencies } from "./foundation-dependencies";
import { stopLiveKitAccess } from "./integrations/livekit/access";
import { handleLiveKitShutdownBatch } from "./integrations/livekit/shutdown-queue";

export { ConversationSession };
export default {
  fetch: (request, env) => handleConversationRequest(request, env, foundationDependencies(env)),
  queue: (batch, env) => {
    const dependencies = foundationDependencies(env);
    return handleLiveKitShutdownBatch(batch, (conversationId) =>
      stopLiveKitAccess(env, conversationId, dependencies),
    );
  },
} satisfies ExportedHandler<Env, LiveKitShutdownMessage>;
