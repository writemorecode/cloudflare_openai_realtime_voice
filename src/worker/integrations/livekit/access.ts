/** Provisions room-scoped LiveKit access, dispatch, and recording resources for a conversation. */
import {
  AccessToken,
  AgentDispatchClient,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  EgressStatus,
  RoomServiceClient,
  S3Upload,
  TrackSource,
  type AgentDispatch,
  type EgressInfo,
} from "livekit-server-sdk";

import { ConversationStateTag, TransportStatus } from "../../../domain/conversation-state-machine";
import type {
  BeginLiveKitProvisioningResult,
  BeginLiveKitShutdownResult,
  LiveKitProvisioningReady,
} from "../../../durable-object/conversation-session";
import { ApiError } from "../../http/api-errors";
import { err, ok, tryCatch, type Result } from "../../try-catch";

export const LIVEKIT_AGENT_NAME = "oral-exam-agent";
export const LIVEKIT_ROOM_PREFIX = "conversation-";
const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
const PROVISIONING_LEASE_MS = 15_000;
const SHUTDOWN_LEASE_MS = 15_000;
const ROOM_EMPTY_TIMEOUT_SECONDS = 5 * 60;
const ROOM_DEPARTURE_TIMEOUT_SECONDS = 30;

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

export interface LiveKitAccessServices {
  roomExists(roomName: string): Promise<boolean>;
  createRoom(roomName: string, metadata: string): Promise<void>;
  listDispatches(roomName: string): Promise<readonly AgentDispatch[]>;
  createDispatch(roomName: string, metadata: string): Promise<AgentDispatch>;
  listActiveEgress(roomName: string): Promise<readonly EgressInfo[]>;
  startEgress(roomName: string, objectKey: string): Promise<EgressInfo>;
  mintParticipantToken(roomName: string, identity: string): Promise<string>;
}

export interface LiveKitShutdownServices {
  getEgress(egressId: string): Promise<EgressInfo | undefined>;
  stopEgress(egressId: string): Promise<void>;
  getDispatch(dispatchId: string, roomName: string): Promise<AgentDispatch | undefined>;
  deleteDispatch(dispatchId: string, roomName: string): Promise<void>;
  roomExists(roomName: string): Promise<boolean>;
  deleteRoom(roomName: string): Promise<void>;
}

export async function createLiveKitAccess(
  env: Env,
  conversationId: string,
  services?: LiveKitAccessServices,
): Promise<Result<LiveKitAccessResponse, ApiError>> {
  const configured = validateLiveKitAccessConfiguration(env);
  if (!configured.ok) return configured;
  const availableServices = await tryCatch(
    () => services ?? liveKitAccessServices(env),
    liveKitProvisioningFailed,
  );
  if (!availableServices.ok) return availableServices;

  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
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
  const leaseId = crypto.randomUUID();
  const now = Date.now();
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
      availableServices.value,
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
      availableServices.value.mintParticipantToken(
        provisioning.roomName,
        `browser-${conversationId}`,
      ),
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
  services?: LiveKitShutdownServices,
): Promise<Result<"stopped" | "already_stopped", ApiError>> {
  const configured = validateLiveKitAccessConfiguration(env);
  if (!configured.ok) return configured;
  const availableServices = await tryCatch(
    () => services ?? liveKitShutdownServices(env),
    liveKitShutdownFailed,
  );
  if (!availableServices.ok) return availableServices;

  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  const leaseId = crypto.randomUUID();
  const now = Date.now();
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
    const egress = await availableServices.value.getEgress(egressId);
    if (
      egress !== undefined &&
      (egress.status === EgressStatus.EGRESS_STARTING ||
        egress.status === EgressStatus.EGRESS_ACTIVE)
    ) {
      await availableServices.value.stopEgress(egressId);
    }
    if ((await availableServices.value.getDispatch(dispatchId, roomName)) !== undefined) {
      await availableServices.value.deleteDispatch(dispatchId, roomName);
    }
    if (await availableServices.value.roomExists(roomName)) {
      await availableServices.value.deleteRoom(roomName);
    }
  }, liveKitShutdownFailed);
  if (!stopped.ok) {
    logLiveKitFailure("livekit_shutdown_failed", conversationId, stopped.error);
    return abandonShutdown(stub, leaseId, stopped.error);
  }

  const completed = await tryCatch(
    () => stub.completeLiveKitShutdown({ leaseId, stoppedAt: Date.now() }),
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
  services: LiveKitAccessServices,
  conversationId: string,
  roomName: string,
  transportEpoch: number,
): Promise<Result<ProvisionedResources, ApiError>> {
  const metadata = JSON.stringify({ version: 1, conversationId, roomName, transportEpoch });
  const existingRoom = await tryCatch(
    () => services.roomExists(roomName),
    liveKitProvisioningFailed,
  );
  if (!existingRoom.ok) return existingRoom;
  if (!existingRoom.value) {
    const createdRoom = await tryCatch(
      () => services.createRoom(roomName, metadata),
      liveKitProvisioningFailed,
    );
    if (!createdRoom.ok) return createdRoom;
  }

  const dispatches = await tryCatch(
    () => services.listDispatches(roomName),
    liveKitProvisioningFailed,
  );
  if (!dispatches.ok) return dispatches;
  const matchingDispatches = dispatches.value.filter(
    (dispatch) => dispatch.agentName === LIVEKIT_AGENT_NAME && dispatch.metadata === metadata,
  );
  if (matchingDispatches.length > 1) {
    return err(
      new ApiError(409, "livekit_dispatch_conflict", "Multiple matching agent dispatches exist."),
    );
  }
  const dispatch =
    matchingDispatches[0] === undefined
      ? await tryCatch(() => services.createDispatch(roomName, metadata), liveKitProvisioningFailed)
      : ok(matchingDispatches[0]);
  if (!dispatch.ok) return dispatch;
  if (dispatch.value.id.length === 0) {
    return err(
      new ApiError(502, "livekit_dispatch_invalid", "LiveKit returned an invalid dispatch."),
    );
  }

  const expectedR2Key = `conversations/${conversationId}/recording.ogg`;
  const activeEgress = await tryCatch(
    () => services.listActiveEgress(roomName),
    liveKitProvisioningFailed,
  );
  if (!activeEgress.ok) return activeEgress;
  if (activeEgress.value.length > 1) {
    return err(new ApiError(409, "livekit_egress_conflict", "Multiple active recordings exist."));
  }
  const egress =
    activeEgress.value[0] === undefined
      ? await tryCatch(
          () => services.startEgress(roomName, expectedR2Key),
          liveKitProvisioningFailed,
        )
      : ok(activeEgress.value[0]);
  if (!egress.ok) return egress;
  if (egress.value.egressId.length === 0) {
    return err(
      new ApiError(502, "livekit_egress_invalid", "LiveKit returned an invalid recording."),
    );
  }
  return ok({
    dispatchId: dispatch.value.id,
    egressId: egress.value.egressId,
    expectedR2Key,
  });
}

function liveKitAccessServices(env: Env): LiveKitAccessServices {
  const roomClient = new RoomServiceClient(
    env.LIVEKIT_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
  );
  const dispatchClient = new AgentDispatchClient(
    env.LIVEKIT_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
  );
  const egressClient = new EgressClient(
    env.LIVEKIT_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
  );
  return {
    roomExists: async (roomName) => (await roomClient.listRooms([roomName])).length === 1,
    createRoom: async (roomName, metadata) => {
      await roomClient.createRoom({
        name: roomName,
        metadata,
        emptyTimeout: ROOM_EMPTY_TIMEOUT_SECONDS,
        departureTimeout: ROOM_DEPARTURE_TIMEOUT_SECONDS,
        maxParticipants: 3,
      });
    },
    listDispatches: async (roomName) => dispatchClient.listDispatch(roomName),
    createDispatch: async (roomName, metadata) =>
      dispatchClient.createDispatch(roomName, LIVEKIT_AGENT_NAME, { metadata }),
    listActiveEgress: async (roomName) => egressClient.listEgress({ roomName, active: true }),
    startEgress: async (roomName, objectKey) =>
      egressClient.startRoomCompositeEgress(
        roomName,
        new EncodedFileOutput({
          fileType: EncodedFileType.OGG,
          filepath: objectKey,
          output: {
            case: "s3",
            value: new S3Upload({
              accessKey: env.R2_S3_ACCESS_KEY_ID,
              secret: env.R2_S3_SECRET_ACCESS_KEY,
              endpoint: env.R2_S3_ENDPOINT,
              bucket: env.R2_BUCKET_NAME,
              forcePathStyle: true,
            }),
          },
        }),
        { audioOnly: true },
      ),
    mintParticipantToken: async (roomName, identity) => {
      const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
        identity,
        ttl: ACCESS_TOKEN_TTL_SECONDS,
        metadata: JSON.stringify({ role: "candidate" }),
      });
      token.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE],
        canPublishData: false,
        canSubscribe: true,
        canUpdateOwnMetadata: false,
      });
      return token.toJwt();
    },
  };
}

function liveKitShutdownServices(env: Env): LiveKitShutdownServices {
  const roomClient = new RoomServiceClient(
    env.LIVEKIT_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
  );
  const dispatchClient = new AgentDispatchClient(
    env.LIVEKIT_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
  );
  const egressClient = new EgressClient(
    env.LIVEKIT_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
  );
  return {
    getEgress: async (egressId) => (await egressClient.listEgress({ egressId }))[0],
    stopEgress: async (egressId) => {
      await egressClient.stopEgress(egressId);
    },
    getDispatch: async (dispatchId, roomName) =>
      (await dispatchClient.listDispatch(roomName)).find((dispatch) => dispatch.id === dispatchId),
    deleteDispatch: async (dispatchId, roomName) =>
      dispatchClient.deleteDispatch(dispatchId, roomName),
    roomExists: async (roomName) => (await roomClient.listRooms([roomName])).length === 1,
    deleteRoom: async (roomName) => roomClient.deleteRoom(roomName),
  };
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
  stub: ReturnType<Env["CONVERSATION_SESSIONS"]["getByName"]>,
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
  stub: ReturnType<Env["CONVERSATION_SESSIONS"]["getByName"]>,
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
