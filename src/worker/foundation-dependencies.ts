/** Production composition of conversation foundation ports. */
import {
  cloudflareConversationSessions,
  cryptoIdGenerator,
  r2RecordingStore,
  systemClock,
} from "./adapters/cloudflare";
import type { FoundationDependencies } from "./ports/foundation";

export function foundationDependencies(env: Env): FoundationDependencies {
  return {
    clock: systemClock,
    ids: cryptoIdGenerator,
    conversations: cloudflareConversationSessions(env),
    recordings: r2RecordingStore(env.RECORDINGS),
  };
}
