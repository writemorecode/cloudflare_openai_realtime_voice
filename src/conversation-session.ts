import { DurableObject } from "cloudflare:workers";

/**
 * Runtime behavior is intentionally deferred. The pure FSM lives in
 * conversation-state-machine.ts and will be integrated here later.
 */
export class ConversationSession extends DurableObject {}
