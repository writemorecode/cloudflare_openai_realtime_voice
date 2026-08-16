/**
 * Cloudflare Worker deployment entrypoint.
 *
 * Wrangler loads this module for the stateless HTTP API and re-exports ConversationSession so the
 * same Cloudflare deployment can bind the stateful Durable Object class.
 */
import { ConversationSession } from "../durable-object/conversation-session";
import { createConversationApi } from "./http/conversation-api";
import { foundationDependencies } from "./foundation-dependencies";
import { TranscriptionWorkflow } from "./transcription/transcription-workflow";
import { reconcileQueuedTranscriptionJobs } from "./transcription/enqueue-transcription";

export { ConversationSession, TranscriptionWorkflow };
export default {
  fetch: async (request, env, executionContext) =>
    await createConversationApi(foundationDependencies(env)).fetch(request, env, executionContext),
  scheduled: async (_controller, env) => {
    const dispatched = await reconcileQueuedTranscriptionJobs(env);
    if (dispatched.isOk()) {
      console.log({ kind: "transcription_reconciliation", dispatched: dispatched.value });
    } else {
      console.error({
        kind: "transcription_reconciliation_failed",
        error: dispatched.error.message,
      });
    }
  },
} satisfies ExportedHandler<Env>;
