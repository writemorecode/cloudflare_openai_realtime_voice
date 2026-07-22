/** Cloudflare binding adapters for foundation ports. */
import type { Clock, ConversationSessions, IdGenerator, RecordingStore } from "../ports/foundation";

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const cryptoIdGenerator: IdGenerator = {
  randomUuid: () => crypto.randomUUID(),
};

export function cloudflareConversationSessions(env: Env): ConversationSessions {
  return {
    get: (conversationId) => env.CONVERSATION_SESSIONS.getByName(conversationId),
  };
}

export function r2RecordingStore(bucket: R2Bucket): RecordingStore {
  return {
    head: async (objectKey) => {
      const object = await bucket.head(objectKey);
      return object === null ? null : { etag: object.etag, size: object.size };
    },
  };
}
