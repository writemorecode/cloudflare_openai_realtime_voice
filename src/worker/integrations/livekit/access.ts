/** Provisions room-scoped LiveKit access, dispatch, and recording resources for a conversation. */
import { ConversationStateTag, TransportStatus } from "../../../domain/conversation-state-machine";
import type {
  BeginLiveKitProvisioningResult,
  BeginLiveKitShutdownResult,
  ConversationSession,
  LiveKitProvisioningReady,
} from "../../../durable-object/conversation-session";
import { ApiError } from "../../http/api-errors";
import type {
  LiveKitAccessDependencies,
  LiveKitAccessPort,
  LiveKitShutdownDependencies,
  LiveKitShutdownPort,
} from "../../ports/foundation";
import { err, ok, tryCatch, type Result } from "@ai-oral-exam/result";
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
  if (!configured.ok) return configured;

  const stub = dependencies.conversations.get(conversationId);
  const state = await tryCatch(
    async (): Promise<Awaited<ReturnType<typeof stub.getState>>> => await stub.getState(),
    liveKitAccessOperationFailed,
  );
  if (!state.ok) return state;
  if (state.value === null) {
    return err(new ApiError(404, "conversation_not_found", "Conversation not found."));
  }
  if (state.value.tag !== ConversationStateTag.Starting) {
    return err(new ApiError(409, "conversation_not_starting", "Conversation is not starting."));
  }
  if (state.value.data.transport.status !== TransportStatus.Connecting) {
    return err(
      new ApiError(409, "transport_not_connecting", "Conversation transport is not connecting."),
    );
  }

  const roomName = `${LIVEKIT_ROOM_PREFIX}${conversationId}`;
  const transportEpoch = state.value.data.transport.epoch;
  const leaseId = dependencies.ids.randomUuid();
  const now = dependencies.clock.now();
  const claim = await tryCatch(
    async (): Promise<BeginLiveKitProvisioningResult> =>
      await stub.beginLiveKitProvisioning({
        roomName,
        transportEpoch,
        leaseId,
        now,
        leaseExpiresAt: now + PROVISIONING_LEASE_MS,
      }),
    liveKitAccessOperationFailed,
  );
  if (!claim.ok) return claim;

  let provisioning: LiveKitProvisioningReady;
  if (claim.value.outcome === "ready") {
    provisioning = claim.value.provisioning;
  } else if (claim.value.outcome === "in_progress") {
    return err(
      new ApiError(409, "livekit_provisioning_in_progress", "LiveKit access is being prepared.", {
        "Retry-After": String(Math.max(1, Math.ceil((claim.value.retryAt - now) / 1000))),
      }),
    );
  } else if (claim.value.outcome === "rejected") {
    return err(
      new ApiError(409, "livekit_provisioning_rejected", "LiveKit access cannot be prepared."),
    );
  } else {
    const resources = await provisionResources(
      dependencies.liveKit,
      conversationId,
      roomName,
      transportEpoch,
    );
    if (!resources.ok) {
      logLiveKitFailure("livekit_access_failed", conversationId, resources.error);
      return abandonProvisioning(stub, leaseId, resources.error);
    }
    provisioning = {
      status: "ready",
      roomName,
      transportEpoch,
      ...resources.value,
    };
    const completed = await tryCatch(
      () => stub.completeLiveKitProvisioning({ ...provisioning, leaseId }),
      liveKitAccessOperationFailed,
    );
    if (!completed.ok) return abandonProvisioning(stub, leaseId, completed.error);
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

  const participantToken = await tryCatch(
    () =>
      dependencies.liveKit.mintParticipantToken(provisioning.roomName, `browser-${conversationId}`),
    liveKitProvisioningFailed,
  );
  if (!participantToken.ok) return participantToken;
  return ok({
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
  if (!configured.ok) return configured;

  const stub = dependencies.conversations.get(conversationId);
  const leaseId = dependencies.ids.randomUuid();
  const now = dependencies.clock.now();
  const claim = await tryCatch(
    async (): Promise<BeginLiveKitShutdownResult> =>
      await stub.beginLiveKitShutdown({
        leaseId,
        now,
        leaseExpiresAt: now + SHUTDOWN_LEASE_MS,
      }),
    liveKitAccessOperationFailed,
  );
  if (!claim.ok) return claim;
  if (claim.value.outcome === "stopped") return ok("already_stopped");
  if (claim.value.outcome === "in_progress") {
    return err(
      new ApiError(409, "livekit_shutdown_in_progress", "LiveKit shutdown is in progress.", {
        "Retry-After": String(Math.max(1, Math.ceil((claim.value.retryAt - now) / 1000))),
      }),
    );
  }
  if (claim.value.outcome === "rejected") {
    return err(
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
  const stopped = await tryCatch(async () => {
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
  }, liveKitShutdownFailed);
  if (!stopped.ok) {
    logLiveKitFailure("livekit_shutdown_failed", conversationId, stopped.error);
    return abandonShutdown(stub, leaseId, stopped.error);
  }

  const completed = await tryCatch(
    () => stub.completeLiveKitShutdown({ leaseId, stoppedAt: dependencies.clock.now() }),
    liveKitAccessOperationFailed,
  );
  if (!completed.ok) return abandonShutdown(stub, leaseId, completed.error);
  if (!completed.value) {
    return abandonShutdown(
      stub,
      leaseId,
      new ApiError(409, "livekit_shutdown_superseded", "LiveKit shutdown was superseded."),
    );
  }
  return ok("stopped");
}

async function provisionResources(
  services: LiveKitAccessPort,
  conversationId: string,
  roomName: string,
  transportEpoch: number,
): Promise<Result<ProvisionedResources, ApiError>> {
  const descriptor = describeLiveKitProvisioning(conversationId, roomName, transportEpoch);
  const existingRoom = await tryCatch(
    () => services.roomExists(roomName),
    liveKitProvisioningFailed,
  );
  if (!existingRoom.ok) return existingRoom;
  if (!existingRoom.value) {
    const createdRoom = await tryCatch(
      () => services.createRoom(roomName, descriptor.metadata),
      liveKitProvisioningFailed,
    );
    if (!createdRoom.ok) return createdRoom;
  }

  const dispatches = await tryCatch(
    () => services.listDispatches(roomName),
    liveKitProvisioningFailed,
  );
  if (!dispatches.ok) return dispatches;
  const dispatchDecision = decideLiveKitDispatch(dispatches.value, descriptor.metadata);
  if (!dispatchDecision.ok) return err(resourceDecisionError(dispatchDecision.error));
  const dispatch =
    dispatchDecision.value.kind === "create"
      ? await tryCatch(
          () => services.createDispatch(roomName, descriptor.metadata),
          liveKitProvisioningFailed,
        )
      : ok(dispatchDecision.value.resource);
  if (!dispatch.ok) return dispatch;
  const validDispatch = validLiveKitDispatch(dispatch.value);
  if (!validDispatch.ok) return err(resourceDecisionError(validDispatch.error));

  const activeEgress = await tryCatch(
    () => services.listActiveEgress(roomName),
    liveKitProvisioningFailed,
  );
  if (!activeEgress.ok) return activeEgress;
  const egressDecision = decideLiveKitEgress(activeEgress.value);
  if (!egressDecision.ok) return err(resourceDecisionError(egressDecision.error));
  const egress =
    egressDecision.value.kind === "create"
      ? await tryCatch(
          () => services.startEgress(roomName, descriptor.expectedR2Key),
          liveKitProvisioningFailed,
        )
      : ok(egressDecision.value.resource);
  if (!egress.ok) return egress;
  const validEgress = validLiveKitEgress(egress.value);
  if (!validEgress.ok) return err(resourceDecisionError(validEgress.error));
  return ok({
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
    env.R2_S3_ENDPOINT,
    env.R2_BUCKET_NAME,
    env.R2_S3_ACCESS_KEY_ID,
    env.R2_S3_SECRET_ACCESS_KEY,
  ];
  if (values.some((value) => value.length === 0)) {
    return err(
      new ApiError(500, "livekit_access_not_configured", "LiveKit access is not configured."),
    );
  }
  if (!env.LIVEKIT_URL.startsWith("wss://") || !env.R2_S3_ENDPOINT.startsWith("https://")) {
    return err(
      new ApiError(500, "livekit_access_not_configured", "LiveKit access is not configured."),
    );
  }
  return ok(undefined);
}

async function abandonProvisioning(
  stub: DurableObjectStub<ConversationSession>,
  leaseId: string,
  error: ApiError,
): Promise<Result<never, ApiError>> {
  const abandoned = await tryCatch(
    () => stub.abandonLiveKitProvisioning(leaseId),
    liveKitAccessOperationFailed,
  );
  return abandoned.ok ? err(error) : abandoned;
}

async function abandonShutdown(
  stub: DurableObjectStub<ConversationSession>,
  leaseId: string,
  error: ApiError,
): Promise<Result<never, ApiError>> {
  const abandoned = await tryCatch(
    () => stub.abandonLiveKitShutdown(leaseId),
    liveKitAccessOperationFailed,
  );
  return abandoned.ok ? err(error) : abandoned;
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
      error: error.cause instanceof Error ? error.cause.name : error.name,
    }),
  );
}
