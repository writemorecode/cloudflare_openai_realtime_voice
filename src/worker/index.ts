/**
 * Cloudflare Worker deployment entrypoint.
 *
 * Wrangler loads this module for the stateless HTTP API and re-exports ConversationSession so the
 * same Cloudflare deployment can bind the stateful Durable Object class.
 */
import { ConversationSession } from "../durable-object/conversation-session";
import { createConversationApi } from "./http/conversation-api";
import { foundationDependencies } from "./foundation-dependencies";

export { ConversationSession };
export default {
  fetch: async (request, env, executionContext) =>
    await createConversationApi(foundationDependencies(env)).fetch(request, env, executionContext),
} satisfies ExportedHandler<Env>;
