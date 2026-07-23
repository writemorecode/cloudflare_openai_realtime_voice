import { WebhookEvent } from "livekit-server-sdk";

import {
  ConversationEventType,
  value,
  type ConversationState,
} from "../../src/domain/conversation-state-machine";
import type { ConversationSession } from "../../src/durable-object/conversation-session";
import type { LiveKitProvisioningReady } from "../../src/durable-object/conversation-session-contract";
import { cloudflareConversationSessions } from "../../src/worker/adapters/cloudflare";
import type { LiveKitAccessResponse } from "../../src/worker/integrations/livekit/access";
import { handleConversationRequest } from "../../src/worker/http/conversation-api";
import type { ConversationStateDto } from "../../src/worker/http/conversation-state-dto";
import type {
  Clock,
  FoundationDependencies,
  IdGenerator,
  LiveKitControlPort,
  LiveKitDispatchResource,
  LiveKitEgressResource,
  LiveKitWebhookVerifier,
  RecordingObject,
  RecordingStore,
} from "../../src/worker/ports/foundation";
import { authenticatedHeaders } from "../auth-helpers";

const API_ORIGIN = "https://api.example.test";
const BROWSER_ORIGIN = "http://localhost:5173";
const WEBHOOK_AUTHORIZATION = "Bearer foundation-harness-webhook";

export type LiveKitOperationKind =
  | "room_exists"
  | "create_room"
  | "list_dispatches"
  | "create_dispatch"
  | "list_active_egress"
  | "start_egress"
  | "mint_token"
  | "get_egress"
  | "stop_egress"
  | "get_dispatch"
  | "delete_dispatch"
  | "delete_room";

export interface LiveKitOperation {
  readonly kind: LiveKitOperationKind;
  readonly roomName?: string;
  readonly resourceId?: string;
}

export class DeterministicClock implements Clock {
  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  set(now: number): void {
    this.current = now;
  }

  advance(milliseconds: number): number {
    this.current += milliseconds;
    return this.current;
  }

  iso(): string {
    return new Date(this.current).toISOString();
  }
}

export class DeterministicIdGenerator implements IdGenerator {
  private nextId = 1;

  randomUuid(): string {
    const suffix = String(this.nextId++).padStart(12, "0");
    return `00000000-0000-4000-8000-${suffix}`;
  }
}

export class InMemoryRecordingStore implements RecordingStore {
  private readonly objects = new Map<string, RecordingObject>();
  readonly headCalls: string[] = [];
  private nextFailure: unknown | undefined;

  async head(objectKey: string): Promise<RecordingObject | null> {
    this.headCalls.push(objectKey);
    if (this.nextFailure !== undefined) {
      const failure = this.nextFailure;
      this.nextFailure = undefined;
      throw failure;
    }
    return this.objects.get(objectKey) ?? null;
  }

  put(objectKey: string, object: RecordingObject = { etag: "etag-harness", size: 1 }): void {
    this.objects.set(objectKey, object);
  }

  failNextHead(cause: unknown = new Error("injected recording-store failure")): void {
    this.nextFailure = cause;
  }
}

export class DeterministicWebhookVerifier implements LiveKitWebhookVerifier {
  readonly receivedBodies: string[] = [];
  private nextFailure: unknown | undefined;

  async verify(rawBody: string, authorization: string | undefined): Promise<WebhookEvent> {
    this.receivedBodies.push(rawBody);
    if (this.nextFailure !== undefined) {
      const failure = this.nextFailure;
      this.nextFailure = undefined;
      throw failure;
    }
    if (authorization !== WEBHOOK_AUTHORIZATION) {
      throw new Error("invalid harness webhook authorization");
    }
    return WebhookEvent.fromJsonString(rawBody, { ignoreUnknownFields: true });
  }

  failNext(cause: unknown = new Error("injected webhook verification failure")): void {
    this.nextFailure = cause;
  }
}

export class InMemoryLiveKitControl implements LiveKitControlPort {
  readonly operations: LiveKitOperation[] = [];
  private readonly rooms = new Map<string, string>();
  private readonly dispatches = new Map<string, LiveKitDispatchResource[]>();
  private readonly egress = new Map<string, LiveKitEgressResource & { roomName: string }>();
  private readonly failures = new Map<LiveKitOperationKind, unknown[]>();
  private dispatchSequence = 1;
  private egressSequence = 1;

  async roomExists(roomName: string): Promise<boolean> {
    this.record({ kind: "room_exists", roomName });
    return this.rooms.has(roomName);
  }

  async createRoom(roomName: string, metadata: string): Promise<void> {
    this.record({ kind: "create_room", roomName });
    this.rooms.set(roomName, metadata);
  }

  async listDispatches(roomName: string): Promise<readonly LiveKitDispatchResource[]> {
    this.record({ kind: "list_dispatches", roomName });
    return [...(this.dispatches.get(roomName) ?? [])];
  }

  async createDispatch(roomName: string, metadata: string): Promise<LiveKitDispatchResource> {
    this.record({ kind: "create_dispatch", roomName });
    const dispatch = {
      id: `AD_${String(this.dispatchSequence++).padStart(4, "0")}`,
      agentName: "oral-exam-agent",
      metadata,
    };
    this.dispatches.set(roomName, [...(this.dispatches.get(roomName) ?? []), dispatch]);
    return dispatch;
  }

  async listActiveEgress(roomName: string): Promise<readonly LiveKitEgressResource[]> {
    this.record({ kind: "list_active_egress", roomName });
    return [...this.egress.values()].filter(
      (resource) => resource.roomName === roomName && resource.active,
    );
  }

  async startEgress(roomName: string, _objectKey: string): Promise<LiveKitEgressResource> {
    this.record({ kind: "start_egress", roomName });
    const resource = {
      egressId: `EG_${String(this.egressSequence++).padStart(4, "0")}`,
      active: true,
      roomName,
    };
    this.egress.set(resource.egressId, resource);
    return resource;
  }

  async mintParticipantToken(roomName: string, identity: string): Promise<string> {
    this.record({ kind: "mint_token", roomName });
    return `harness-token:${roomName}:${identity}`;
  }

  async getEgress(egressId: string): Promise<LiveKitEgressResource | undefined> {
    this.record({ kind: "get_egress", resourceId: egressId });
    return this.egress.get(egressId);
  }

  async stopEgress(egressId: string): Promise<void> {
    this.record({ kind: "stop_egress", resourceId: egressId });
    const resource = this.egress.get(egressId);
    if (resource !== undefined) this.egress.set(egressId, { ...resource, active: false });
  }

  async getDispatch(
    dispatchId: string,
    roomName: string,
  ): Promise<LiveKitDispatchResource | undefined> {
    this.record({ kind: "get_dispatch", roomName, resourceId: dispatchId });
    return this.dispatches.get(roomName)?.find((dispatch) => dispatch.id === dispatchId);
  }

  async deleteDispatch(dispatchId: string, roomName: string): Promise<void> {
    this.record({ kind: "delete_dispatch", roomName, resourceId: dispatchId });
    this.dispatches.set(
      roomName,
      (this.dispatches.get(roomName) ?? []).filter((dispatch) => dispatch.id !== dispatchId),
    );
  }

  async deleteRoom(roomName: string): Promise<void> {
    this.record({ kind: "delete_room", roomName });
    this.rooms.delete(roomName);
  }

  failNext(
    kind: LiveKitOperationKind,
    cause: unknown = new Error(`injected ${kind} failure`),
  ): void {
    this.failures.set(kind, [...(this.failures.get(kind) ?? []), cause]);
  }

  count(kind: LiveKitOperationKind): number {
    return this.operations.filter((operation) => operation.kind === kind).length;
  }

  egressForRoom(roomName: string): LiveKitEgressResource | undefined {
    return [...this.egress.values()].find((resource) => resource.roomName === roomName);
  }

  private record(operation: LiveKitOperation): void {
    this.operations.push(operation);
    const queued = this.failures.get(operation.kind);
    const failure = queued?.shift();
    if (failure !== undefined) throw failure;
  }
}

export interface FoundationHarnessOptions {
  readonly now?: number;
}

export interface SuccessfulRecording {
  readonly objectKey: string;
  readonly etag: string;
  readonly size: number;
}

export class FoundationHarness {
  readonly clock: DeterministicClock;
  readonly ids = new DeterministicIdGenerator();
  readonly liveKit = new InMemoryLiveKitControl();
  readonly recordings = new InMemoryRecordingStore();
  readonly webhooks = new DeterministicWebhookVerifier();
  readonly dependencies: FoundationDependencies;
  private webhookSequence = 1;
  private agentSequence = 1;

  constructor(
    readonly env: Env,
    options: FoundationHarnessOptions = {},
  ) {
    // Keep real Durable Object alarms dormant unless a scenario explicitly
    // exercises them. The harness controls event time, while Miniflare owns
    // the wall clock used to deliver scheduled alarms.
    this.clock = new DeterministicClock(options.now ?? 4_102_444_800_000);
    this.dependencies = {
      clock: this.clock,
      ids: this.ids,
      conversations: cloudflareConversationSessions(env),
      recordings: this.recordings,
      liveKitWebhook: this.webhooks,
      liveKit: this.liveKit,
    };
  }

  session(conversationId: string): DurableObjectStub<ConversationSession> {
    return this.dependencies.conversations.get(conversationId);
  }

  async state(conversationId: string): Promise<ConversationState | null> {
    return this.session(conversationId).getState();
  }

  async browserRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = await authenticatedHeaders(init.headers);
    if (!headers.has("Origin")) headers.set("Origin", BROWSER_ORIGIN);
    return this.request(path, { ...init, headers });
  }

  request(path: string, init: RequestInit = {}): Promise<Response> {
    return handleConversationRequest(
      new Request(`${API_ORIGIN}${path}`, init),
      this.env,
      this.dependencies,
    );
  }

  async createConversation(idempotencyKey: string): Promise<ConversationStateDto> {
    const response = await this.browserRequest("/v1/conversations", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    });
    return responseJson(response, [200, 201]);
  }

  async startConversation(conversationId: string): Promise<ConversationStateDto> {
    const response = await this.browserRequest(`/v1/conversations/${conversationId}/start`, {
      method: "POST",
    });
    return responseJson(response, [202]);
  }

  async getConversation(conversationId: string): Promise<ConversationStateDto> {
    const response = await this.browserRequest(`/v1/conversations/${conversationId}/state`);
    return responseJson(response, [200]);
  }

  async createStartedConversation(idempotencyKey: string): Promise<ConversationStateDto> {
    const created = await this.createConversation(idempotencyKey);
    return this.startConversation(created.conversationId);
  }

  async provisionConversation(conversationId: string): Promise<LiveKitAccessResponse> {
    const response = await this.browserRequest(
      `/v1/conversations/${conversationId}/livekit-access`,
      { method: "POST" },
    );
    return responseJson(response, [200]);
  }

  async stopConversationResources(conversationId: string): Promise<Response> {
    return this.browserRequest(`/v1/conversations/${conversationId}/livekit-access`, {
      method: "DELETE",
    });
  }

  async provisioning(conversationId: string): Promise<LiveKitProvisioningReady> {
    const provisioning = await this.session(conversationId).getLiveKitProvisioning();
    if (provisioning === null) throw new Error("conversation is not provisioned");
    return provisioning;
  }

  async recordingStarted(conversationId: string): Promise<void> {
    const provisioning = await this.provisioning(conversationId);
    await expectStatus(
      this.webhook({
        event: "egress_started",
        id: this.nextWebhookId(),
        egressInfo: {
          egressId: provisioning.egressId,
          roomName: provisioning.roomName,
          status: "EGRESS_ACTIVE",
          fileResults: [],
        },
      }),
      204,
    );
  }

  async reachLive(
    conversationId: string,
    agentIdentity = "agent-foundation-harness",
  ): Promise<void> {
    await this.recordingStarted(conversationId);
    await expectStatus(this.agentEvent(conversationId, "realtime_ready"), 204);

    const room = { name: this.roomName(conversationId) };
    const browserIdentity = `browser-${conversationId}`;
    const observations = [
      {
        event: "participant_joined",
        id: this.nextWebhookId(),
        room,
        participant: { identity: browserIdentity, kind: "STANDARD" },
      },
      {
        event: "track_published",
        id: this.nextWebhookId(),
        room,
        participant: { identity: browserIdentity },
        track: { sid: "TR_harness_browser", type: "AUDIO", source: "MICROPHONE" },
      },
      {
        event: "participant_joined",
        id: this.nextWebhookId(),
        room,
        participant: { identity: agentIdentity, kind: "AGENT" },
      },
      {
        event: "track_published",
        id: this.nextWebhookId(),
        room,
        participant: { identity: agentIdentity },
        track: { sid: "TR_harness_agent", type: "AUDIO", source: "MICROPHONE" },
      },
    ];

    await observations.reduce(
      (previous, observation) => previous.then(() => expectStatus(this.webhook(observation), 204)),
      Promise.resolve(),
    );
  }

  async completeRecording(
    conversationId: string,
    object: RecordingObject = { etag: "etag-foundation-harness", size: 4 },
  ): Promise<SuccessfulRecording> {
    const provisioning = await this.provisioning(conversationId);
    this.recordings.put(provisioning.expectedR2Key, object);
    await expectStatus(
      this.webhook({
        event: "egress_ended",
        id: this.nextWebhookId(),
        egressInfo: {
          egressId: provisioning.egressId,
          roomName: provisioning.roomName,
          status: "EGRESS_COMPLETE",
          fileResults: [
            {
              filename: provisioning.expectedR2Key,
              size: String(object.size),
            },
          ],
        },
      }),
      204,
    );
    return {
      objectKey: provisioning.expectedR2Key,
      etag: object.etag,
      size: object.size,
    };
  }

  async closeRoom(conversationId: string): Promise<void> {
    await expectStatus(
      this.webhook({
        event: "room_finished",
        id: this.nextWebhookId(),
        room: { sid: "RM_foundation_harness", name: this.roomName(conversationId) },
      }),
      204,
    );
  }

  async webhook(payload: Record<string, unknown>): Promise<Response> {
    const body = JSON.stringify({
      createdAt: String(Math.floor(this.clock.now() / 1000)),
      ...payload,
    });
    return this.request("/v1/integrations/livekit/webhook", {
      method: "POST",
      headers: {
        Authorization: WEBHOOK_AUTHORIZATION,
        "Content-Type": "application/webhook+json",
      },
      body,
    });
  }

  async agentEvent(
    conversationId: string,
    type:
      | "realtime_ready"
      | "realtime_interrupted"
      | "realtime_recovered"
      | "realtime_failed"
      | "session_closed",
    options: {
      readonly transportEpoch?: number;
      readonly eventId?: string;
      readonly errorCode?: string;
      readonly roomName?: string;
      readonly token?: string;
    } = {},
  ): Promise<Response> {
    const transportEpoch = options.transportEpoch ?? 1;
    const eventId =
      options.eventId ??
      `agent:${conversationId}:${transportEpoch}:${eventSuffix(type)}-${letters(this.agentSequence++)}`;
    return this.request("/v1/integrations/livekit/agent-events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token ?? "test-agent-callback-token"}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        type,
        eventId,
        conversationId,
        roomName: options.roomName ?? this.roomName(conversationId),
        transportEpoch,
        occurredAt: this.clock.iso(),
        ...(type === "realtime_failed"
          ? { errorCode: options.errorCode ?? "transport.agent_realtime_failed" }
          : {}),
      }),
    });
  }

  async beginEnding(conversationId: string, reason = "harness_requested"): Promise<void> {
    const state = await this.state(conversationId);
    if (state === null) throw new Error("conversation is not initialized");
    const result = await this.session(conversationId).applyEvent({
      expectedRevision: state.revision,
      event: {
        type: ConversationEventType.EndRequested,
        eventId: `harness:${conversationId}:end`,
        at: value.unixMillis(this.clock.now()),
        reason,
        endingDeadlineAt: value.unixMillis(this.clock.now() + 30_000),
      },
    });
    if (result.outcome !== "applied") {
      throw new Error(`could not begin ending: ${result.outcome}`);
    }
  }

  roomName(conversationId: string): string {
    return `conversation-${conversationId}`;
  }

  nextWebhookId(): string {
    return `EV_${String(this.webhookSequence++).padStart(12, "0")}`;
  }
}

async function responseJson<T>(
  response: Response,
  expectedStatuses: readonly number[],
): Promise<T> {
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`unexpected response ${response.status}: ${await response.text()}`);
  }
  return response.json<T>();
}

async function expectStatus(response: Promise<Response>, expectedStatus: number): Promise<void> {
  const resolved = await response;
  if (resolved.status !== expectedStatus) {
    throw new Error(`unexpected response ${resolved.status}: ${await resolved.text()}`);
  }
}

function eventSuffix(type: string): string {
  return type.replaceAll("_", "-");
}

function letters(sequence: number): string {
  let remaining = sequence;
  let result = "";
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode(97 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}
