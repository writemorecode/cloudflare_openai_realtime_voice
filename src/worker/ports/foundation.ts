/** External effects used by the conversation foundation. */
import type { ConversationSession } from "../../durable-object/conversation-session";

export interface Clock {
  now(): number;
}

export interface IdGenerator {
  randomUuid(): string;
}

export interface ConversationSessions {
  get(conversationId: string): DurableObjectStub<ConversationSession>;
}

export interface RecordingObject {
  readonly etag: string;
  readonly size: number;
}

export interface RecordingStore {
  head(objectKey: string): Promise<RecordingObject | null>;
}

export interface FoundationDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly conversations: ConversationSessions;
  readonly recordings: RecordingStore;
}
