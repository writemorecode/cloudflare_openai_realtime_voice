/** External effects used by the conversation foundation. */
import type { WebhookEvent } from "livekit-server-sdk";
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

export interface LiveKitWebhookVerifier {
  verify(rawBody: string, authorization: string | undefined): Promise<WebhookEvent>;
}

export interface LiveKitDispatchResource {
  readonly id: string;
  readonly agentName: string;
  readonly metadata: string;
}

export interface LiveKitEgressResource {
  readonly egressId: string;
  readonly active: boolean;
}

export interface LiveKitAccessPort {
  roomExists(roomName: string): Promise<boolean>;
  createRoom(roomName: string, metadata: string): Promise<void>;
  listDispatches(roomName: string): Promise<readonly LiveKitDispatchResource[]>;
  createDispatch(roomName: string, metadata: string): Promise<LiveKitDispatchResource>;
  listActiveEgress(roomName: string): Promise<readonly LiveKitEgressResource[]>;
  startEgress(roomName: string, objectKey: string): Promise<LiveKitEgressResource>;
  mintParticipantToken(roomName: string, identity: string): Promise<string>;
}

export interface LiveKitShutdownPort {
  getEgress(egressId: string): Promise<LiveKitEgressResource | undefined>;
  stopEgress(egressId: string): Promise<void>;
  getDispatch(dispatchId: string, roomName: string): Promise<LiveKitDispatchResource | undefined>;
  deleteDispatch(dispatchId: string, roomName: string): Promise<void>;
  roomExists(roomName: string): Promise<boolean>;
  deleteRoom(roomName: string): Promise<void>;
}

export interface LiveKitControlPort extends LiveKitAccessPort, LiveKitShutdownPort {}

export interface FoundationDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly conversations: ConversationSessions;
  readonly recordings: RecordingStore;
  readonly liveKitWebhook: LiveKitWebhookVerifier;
  readonly liveKit: LiveKitControlPort;
}

export type LiveKitAccessDependencies = Pick<
  FoundationDependencies,
  "clock" | "ids" | "conversations"
> &
  Readonly<{ liveKit: LiveKitAccessPort }>;

export type LiveKitShutdownDependencies = Pick<
  FoundationDependencies,
  "clock" | "ids" | "conversations"
> &
  Readonly<{ liveKit: LiveKitShutdownPort }>;

export type LiveKitWebhookDependencies = Pick<
  FoundationDependencies,
  "clock" | "conversations" | "recordings" | "liveKitWebhook"
>;

export type AgentEventDependencies = Pick<FoundationDependencies, "clock" | "conversations">;
