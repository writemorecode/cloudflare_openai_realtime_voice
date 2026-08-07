/** Provisions room-scoped LiveKit access, dispatch, and recording resources for a conversation. */
import { deserializeResult } from "@ai-oral-exam/conversation-contract";
import {
  ConversationStateTag,
  TransportStatus,
  type ConversationState,
} from "../../../domain/conversation-state-machine";
import type {
  BeginLiveKitProvisioningResult,
  BeginLiveKitShutdownResult,
  ConversationSession,
  LiveKitProvisioningReady,
} from "../../../durable-object/conversation-session";
import type {
  AggregateStoreError,
  AggregateStoreResult,
} from "../../../durable-object/conversation-aggregate-store";
import { observableError } from "../../../shared/observable-error";
import { ApiError } from "../../http/api-errors";
import type {
  LiveKitAccessDependencies,
  LiveKitAccessPort,
  LiveKitShutdownDependencies,
  LiveKitShutdownPort,
} from "../../ports/foundation";
import { Result } from "better-result";
import {
  decideLiveKitDispatch,
  decideLiveKitEgress,
  describeLiveKitProvisioning,
  validLiveKitDispatch,
  validLiveKitEgress,
  type LiveKitResourceDecisionError,
} from "./access-decisions";

export const LIVEKIT_ROOM_PREFIX = "conversation-";
const PROVISIONING_LEASE_MS = 15_000;
const SHUTDOWN_LEASE_MS = 15_000;

export interface LiveKitAccessResponse {
  readonly roomName: string;
  readonly serverUrl: string;
  readonly participantToken: string;
}

interface ProvisionedResources {
  readonly dispatchId: string;
  readonly egressId: string;
  readonly expectedR2Key: string;
}

export type LiveKitAccessServices = LiveKitAccessPort;
export type LiveKitShutdownServices = LiveKitShutdownPort;

export async function createLiveKitAccess(
  env: Env,
  conversationId: string,
  dependencies: LiveKitAccessDependencies,
): Promise<Result<LiveKitAccessResponse, ApiError>> {
  const configured = validateLiveKitAccessConfiguration(env);
  if (!configured.isOk()) return configured;

  const stub = dependencies.conversations.get(conversationId);
  const state = await Result.tryPromise({
    try: async (): Promise<AggregateStoreResult<ConversationState | null>> =>
      deserializeResult<ConversationState | null, AggregateStoreError>(await stub.getState()),
    catch: liveKitAccessOperationFailed,
  });
  if (!state.isOk()) return state;
  if (!state.value.isOk()) return Result.err(liveKitAccessOperationFailed(state.value.error));
  const current = state.value.value;
  if (current === null) {
    return Result.err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  if (current.tag !== ConversationStateTag.Starting) {
    return Result.err(
      new ApiError(409, "conversation_not_starting", "Conversation is not starting."),
    );
  }
  if (current.data.transport.status !== TransportStatus.Connecting) {
    return Result.err(
      new ApiError(409, "transport_not_connecting", "Conversation transport is not connecting."),
    );
  }

  const roomName = `${LIVEKIT_ROOM_PREFIX}${conversationId}`;
  const transportEpoch = current.data.transport.epoch;
  const leaseId = dependencies.ids.randomUuid();
  const now = dependencies.clock.now();
  const claim = await Result.tryPromise({
    try: async (): Promise<BeginLiveKitProvisioningResult> =>
      await stub.beginLiveKitProvisioning({
        roomName,
        transportEpoch,
        leaseId,
        now,
        leaseExpiresAt: now + PROVISIONING_LEASE_MS,
      }),
    catch: liveKitAccessOperationFailed,
  });
  if (!claim.isOk()) return claim;

  let provisioning: LiveKitProvisioningReady;
  if (claim.value.outcome === "ready") {
    provisioning = claim.value.provisioning;
  } else if (claim.value.outcome === "in_progress") {
    return Result.err(
      new ApiError(409, "livekit_provisioning_in_progress", "LiveKit access is being prepared.", {
        "Retry-After": String(Math.max(1, Math.ceil((claim.value.retryAt - now) / 1000))),
      }),
    );
  } else if (claim.value.outcome === "rejected") {
    return Result.err(
      new ApiError(409, "livekit_provisioning_rejected", "LiveKit access cannot be prepared."),
    );
  } else {
    const resources = await provisionResources(
      dependencies.liveKit,
      conversationId,
      roomName,
      transportEpoch,
    );
    if (!resources.isOk()) {
      logLiveKitFailure("livekit_access_failed", conversationId, resources.error);
      return abandonProvisioning(stub, leaseId, resources.error);
    }
    provisioning = {
      status: "ready",
      roomName,
      transportEpoch,
      ...resources.value,
    };
    const completed = await Result.tryPromise({
      try: () => stub.completeLiveKitProvisioning({ ...provisioning, leaseId }),
      catch: liveKitAccessOperationFailed,
    });
    if (!completed.isOk()) return abandonProvisioning(stub, leaseId, completed.error);
    if (!completed.value) {
      return abandonProvisioning(
        stub,
        leaseId,
        new ApiError(
          409,
          "livekit_provisioning_superseded",
          "LiveKit access provisioning was superseded.",
        ),
      );
    }
  }

  const participantToken = await Result.tryPromise({
    try: () =>
      dependencies.liveKit.mintParticipantToken(provisioning.roomName, `browser-${conversationId}`),
    catch: liveKitProvisioningFailed,
  });
  if (!participantToken.isOk()) return participantToken;
  return Result.ok({
    roomName: provisioning.roomName,
    serverUrl: env.LIVEKIT_URL,
    participantToken: participantToken.value,
  });
}

export async function stopLiveKitAccess(
  env: Env,
  conversationId: string,
  dependencies: LiveKitShutdownDependencies,
): Promise<Result<"stopped" | "already_stopped", ApiError>> {
  const configured = validateLiveKitAccessConfiguration(env);
  if (!configured.isOk()) return configured;

  const stub = dependencies.conversations.get(conversationId);
  const leaseId = dependencies.ids.randomUuid();
  const now = dependencies.clock.now();
  const claim = await Result.tryPromise({
    try: async (): Promise<BeginLiveKitShutdownResult> =>
      await stub.beginLiveKitShutdown({
        leaseId,
        now,
        leaseExpiresAt: now + SHUTDOWN_LEASE_MS,
      }),
    catch: liveKitAccessOperationFailed,
  });
  if (!claim.isOk()) return claim;
  if (claim.value.outcome === "stopped") return Result.ok("already_stopped");
  if (claim.value.outcome === "in_progress") {
    return Result.err(
      new ApiError(409, "livekit_shutdown_in_progress", "LiveKit shutdown is in progress.", {
        "Retry-After": String(Math.max(1, Math.ceil((claim.value.retryAt - now) / 1000))),
      }),
    );
  }
  if (claim.value.outcome === "rejected") {
    return Result.err(
      new ApiError(
        409,
        claim.value.reason === "conversation_active"
          ? "conversation_not_ending"
          : "livekit_not_provisioned",
        "LiveKit resources cannot be stopped.",
      ),
    );
  }

  const provisioning = claim.value.provisioning;
  const stopped = await Result.tryPromise({
    try: async () => {
      const { egressId, dispatchId, roomName } = provisioning;
      const egress = await dependencies.liveKit.getEgress(egressId);
      if (egress?.active === true) {
        await dependencies.liveKit.stopEgress(egressId);
      }
      if ((await dependencies.liveKit.getDispatch(dispatchId, roomName)) !== undefined) {
        await dependencies.liveKit.deleteDispatch(dispatchId, roomName);
      }
      if (await dependencies.liveKit.roomExists(roomName)) {
        await dependencies.liveKit.deleteRoom(roomName);
      }
    },
    catch: liveKitShutdownFailed,
  });
  if (!stopped.isOk()) {
    logLiveKitFailure("livekit_shutdown_failed", conversationId, stopped.error);
    return abandonShutdown(stub, leaseId, stopped.error);
  }

  const completed = await Result.tryPromise({
    try: () => stub.completeLiveKitShutdown({ leaseId, stoppedAt: dependencies.clock.now() }),
    catch: liveKitAccessOperationFailed,
  });
  if (!completed.isOk()) return abandonShutdown(stub, leaseId, completed.error);
  if (!completed.value) {
    return abandonShutdown(
      stub,
      leaseId,
      new ApiError(409, "livekit_shutdown_superseded", "LiveKit shutdown was superseded."),
    );
  }
  return Result.ok("stopped");
}

async function provisionResources(
  services: LiveKitAccessPort,
  conversationId: string,
  roomName: string,
  transportEpoch: number,
): Promise<Result<ProvisionedResources, ApiError>> {
  const descriptor = describeLiveKitProvisioning(conversationId, roomName, transportEpoch);
  const existingRoom = await Result.tryPromise({
    try: () => services.roomExists(roomName),
    catch: liveKitProvisioningFailed,
  });
  if (!existingRoom.isOk()) return existingRoom;
  if (!existingRoom.value) {
    const createdRoom = await Result.tryPromise({
      try: () => services.createRoom(roomName, descriptor.metadata),
      catch: liveKitProvisioningFailed,
    });
    if (!createdRoom.isOk()) return createdRoom;
  }

  const dispatches = await Result.tryPromise({
    try: () => services.listDispatches(roomName),
    catch: liveKitProvisioningFailed,
  });
  if (!dispatches.isOk()) return dispatches;
  const dispatchDecision = decideLiveKitDispatch(dispatches.value, descriptor.metadata);
  if (!dispatchDecision.isOk()) return Result.err(resourceDecisionError(dispatchDecision.error));
  const dispatch =
    dispatchDecision.value.kind === "create"
      ? await Result.tryPromise({
          try: () => services.createDispatch(roomName, descriptor.metadata),
          catch: liveKitProvisioningFailed,
        })
      : Result.ok(dispatchDecision.value.resource);
  if (!dispatch.isOk()) return dispatch;
  const validDispatch = validLiveKitDispatch(dispatch.value);
  if (!validDispatch.isOk()) return Result.err(resourceDecisionError(validDispatch.error));

  const activeEgress = await Result.tryPromise({
    try: () => services.listActiveEgress(roomName),
    catch: liveKitProvisioningFailed,
  });
  if (!activeEgress.isOk()) return activeEgress;
  const egressDecision = decideLiveKitEgress(activeEgress.value);
  if (!egressDecision.isOk()) return Result.err(resourceDecisionError(egressDecision.error));
  const egress =
    egressDecision.value.kind === "create"
      ? await Result.tryPromise({
          try: () => services.startEgress(roomName, descriptor.expectedR2Key),
          catch: liveKitProvisioningFailed,
        })
      : Result.ok(egressDecision.value.resource);
  if (!egress.isOk()) return egress;
  const validEgress = validLiveKitEgress(egress.value);
  if (!validEgress.isOk()) return Result.err(resourceDecisionError(validEgress.error));
  return Result.ok({
    dispatchId: validDispatch.value.id,
    egressId: validEgress.value.egressId,
    expectedR2Key: descriptor.expectedR2Key,
  });
}

function resourceDecisionError(error: LiveKitResourceDecisionError): ApiError {
  switch (error) {
    case "dispatch_conflict":
      return new ApiError(
        409,
        "livekit_dispatch_conflict",
        "Multiple matching agent dispatches exist.",
      );
    case "dispatch_invalid":
      return new ApiError(502, "livekit_dispatch_invalid", "LiveKit returned an invalid dispatch.");
    case "egress_conflict":
      return new ApiError(409, "livekit_egress_conflict", "Multiple active recordings exist.");
    case "egress_invalid":
      return new ApiError(502, "livekit_egress_invalid", "LiveKit returned an invalid recording.");
  }
}

function validateLiveKitAccessConfiguration(env: Env): Result<void, ApiError> {
  const values = [
    env.LIVEKIT_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
    env.R2_ENDPOINT,
    env.R2_BUCKET_NAME,
    env.R2_ACCESS_KEY_ID,
    env.R2_SECRET_ACCESS_KEY,
  ];
  if (values.some((value) => value.length === 0)) {
    return Result.err(
      new ApiError(500, "livekit_access_not_configured", "LiveKit access is not configured."),
    );
  }
  if (!env.LIVEKIT_URL.startsWith("wss://") || !env.R2_ENDPOINT.startsWith("https://")) {
    return Result.err(
      new ApiError(500, "livekit_access_not_configured", "LiveKit access is not configured."),
    );
  }
  return Result.ok(undefined);
}

async function abandonProvisioning(
  stub: DurableObjectStub<ConversationSession>,
  leaseId: string,
  error: ApiError,
): Promise<Result<never, ApiError>> {
  const abandoned = await Result.tryPromise({
    try: () => stub.abandonLiveKitProvisioning(leaseId),
    catch: liveKitAccessOperationFailed,
  });
  return abandoned.isOk() ? Result.err(error) : abandoned;
}

async function abandonShutdown(
  stub: DurableObjectStub<ConversationSession>,
  leaseId: string,
  error: ApiError,
): Promise<Result<never, ApiError>> {
  const abandoned = await Result.tryPromise({
    try: () => stub.abandonLiveKitShutdown(leaseId),
    catch: liveKitAccessOperationFailed,
  });
  return abandoned.isOk() ? Result.err(error) : abandoned;
}

function liveKitAccessOperationFailed(cause: unknown): ApiError {
  return new ApiError(
    500,
    "livekit_access_operation_failed",
    "LiveKit access could not be processed.",
    {},
    cause,
  );
}

function liveKitProvisioningFailed(cause: unknown): ApiError {
  return new ApiError(
    502,
    "livekit_provisioning_failed",
    "LiveKit access could not be prepared.",
    {},
    cause,
  );
}

function liveKitShutdownFailed(cause: unknown): ApiError {
  return new ApiError(
    502,
    "livekit_shutdown_failed",
    "LiveKit resources could not be stopped.",
    {},
    cause,
  );
}

function logLiveKitFailure(kind: string, conversationId: string, error: ApiError): void {
  console.error(
    JSON.stringify({
      kind,
      conversationId,
      operation:
        kind === "livekit_access_failed" ? "provision_livekit_access" : "stop_livekit_resources",
      error: observableError(error),
    }),
  );
}
