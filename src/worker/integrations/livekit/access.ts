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
import type { LiveKitProvisioningReady } from "../../../durable-object/conversation-session";
import { ApiError } from "../../http/api-errors";

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
  services: LiveKitAccessServices = liveKitAccessServices(env),
): Promise<LiveKitAccessResponse> {
  assertLiveKitAccessConfiguration(env);
  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  const state = await stub.getState();
  if (state === null) {
    throw new ApiError(404, "conversation_not_found", "Conversation not found.");
  }
  if (state.tag !== ConversationStateTag.Starting) {
    throw new ApiError(409, "conversation_not_starting", "Conversation is not starting.");
  }
  if (state.data.transport.status !== TransportStatus.Connecting) {
    throw new ApiError(
      409,
      "transport_not_connecting",
      "Conversation transport is not connecting.",
    );
  }

  const roomName = `${LIVEKIT_ROOM_PREFIX}${conversationId}`;
  const transportEpoch = state.data.transport.epoch;
  const leaseId = crypto.randomUUID();
  const now = Date.now();
  const claim = await stub.beginLiveKitProvisioning({
    roomName,
    transportEpoch,
    leaseId,
    now,
    leaseExpiresAt: now + PROVISIONING_LEASE_MS,
  });

  let provisioning: LiveKitProvisioningReady;
  if (claim.outcome === "ready") {
    provisioning = claim.provisioning;
  } else if (claim.outcome === "in_progress") {
    throw new ApiError(
      409,
      "livekit_provisioning_in_progress",
      "LiveKit access is being prepared.",
      {
        "Retry-After": String(Math.max(1, Math.ceil((claim.retryAt - now) / 1000))),
      },
    );
  } else if (claim.outcome === "rejected") {
    throw new ApiError(409, "livekit_provisioning_rejected", "LiveKit access cannot be prepared.");
  } else {
    try {
      const resources = await provisionResources(
        services,
        conversationId,
        roomName,
        transportEpoch,
      );
      provisioning = {
        status: "ready",
        roomName,
        transportEpoch,
        ...resources,
      };
      const completed = await stub.completeLiveKitProvisioning({ ...provisioning, leaseId });
      if (!completed) {
        throw new ApiError(
          409,
          "livekit_provisioning_superseded",
          "LiveKit access provisioning was superseded.",
        );
      }
    } catch (error) {
      await stub.abandonLiveKitProvisioning(leaseId);
      if (error instanceof ApiError) throw error;
      console.error(
        JSON.stringify({
          kind: "livekit_access_failed",
          conversationId,
          error: error instanceof Error ? error.name : "unknown_error",
        }),
      );
      throw new ApiError(
        502,
        "livekit_provisioning_failed",
        "LiveKit access could not be prepared.",
      );
    }
  }

  const participantToken = await services.mintParticipantToken(
    provisioning.roomName,
    `browser-${conversationId}`,
  );
  return { roomName: provisioning.roomName, serverUrl: env.LIVEKIT_URL, participantToken };
}

export async function stopLiveKitAccess(
  env: Env,
  conversationId: string,
  services: LiveKitShutdownServices = liveKitShutdownServices(env),
): Promise<"stopped" | "already_stopped"> {
  assertLiveKitAccessConfiguration(env);
  const stub = env.CONVERSATION_SESSIONS.getByName(conversationId);
  const leaseId = crypto.randomUUID();
  const now = Date.now();
  const claim = await stub.beginLiveKitShutdown({
    leaseId,
    now,
    leaseExpiresAt: now + SHUTDOWN_LEASE_MS,
  });
  if (claim.outcome === "stopped") return "already_stopped";
  if (claim.outcome === "in_progress") {
    throw new ApiError(409, "livekit_shutdown_in_progress", "LiveKit shutdown is in progress.", {
      "Retry-After": String(Math.max(1, Math.ceil((claim.retryAt - now) / 1000))),
    });
  }
  if (claim.outcome === "rejected") {
    throw new ApiError(
      409,
      claim.reason === "conversation_active"
        ? "conversation_not_ending"
        : "livekit_not_provisioned",
      "LiveKit resources cannot be stopped.",
    );
  }

  try {
    const { egressId, dispatchId, roomName } = claim.provisioning;
    const egress = await services.getEgress(egressId);
    if (
      egress !== undefined &&
      (egress.status === EgressStatus.EGRESS_STARTING ||
        egress.status === EgressStatus.EGRESS_ACTIVE)
    ) {
      await services.stopEgress(egressId);
    }
    if ((await services.getDispatch(dispatchId, roomName)) !== undefined) {
      await services.deleteDispatch(dispatchId, roomName);
    }
    if (await services.roomExists(roomName)) {
      await services.deleteRoom(roomName);
    }
    if (!(await stub.completeLiveKitShutdown({ leaseId, stoppedAt: Date.now() }))) {
      throw new ApiError(409, "livekit_shutdown_superseded", "LiveKit shutdown was superseded.");
    }
    return "stopped";
  } catch (error) {
    await stub.abandonLiveKitShutdown(leaseId);
    if (error instanceof ApiError) throw error;
    console.error(
      JSON.stringify({
        kind: "livekit_shutdown_failed",
        conversationId,
        error: error instanceof Error ? error.name : "unknown_error",
      }),
    );
    throw new ApiError(502, "livekit_shutdown_failed", "LiveKit resources could not be stopped.");
  }
}

async function provisionResources(
  services: LiveKitAccessServices,
  conversationId: string,
  roomName: string,
  transportEpoch: number,
): Promise<ProvisionedResources> {
  const metadata = JSON.stringify({ version: 1, conversationId, roomName, transportEpoch });
  if (!(await services.roomExists(roomName))) {
    await services.createRoom(roomName, metadata);
  }

  const dispatches = await services.listDispatches(roomName);
  const matchingDispatches = dispatches.filter(
    (dispatch) => dispatch.agentName === LIVEKIT_AGENT_NAME && dispatch.metadata === metadata,
  );
  if (matchingDispatches.length > 1) {
    throw new ApiError(
      409,
      "livekit_dispatch_conflict",
      "Multiple matching agent dispatches exist.",
    );
  }
  const dispatch = matchingDispatches[0] ?? (await services.createDispatch(roomName, metadata));
  if (dispatch.id.length === 0) {
    throw new ApiError(502, "livekit_dispatch_invalid", "LiveKit returned an invalid dispatch.");
  }

  const expectedR2Key = `conversations/${conversationId}/recording.ogg`;
  const activeEgress = await services.listActiveEgress(roomName);
  if (activeEgress.length > 1) {
    throw new ApiError(409, "livekit_egress_conflict", "Multiple active recordings exist.");
  }
  const egress = activeEgress[0] ?? (await services.startEgress(roomName, expectedR2Key));
  if (egress.egressId.length === 0) {
    throw new ApiError(502, "livekit_egress_invalid", "LiveKit returned an invalid recording.");
  }
  return { dispatchId: dispatch.id, egressId: egress.egressId, expectedR2Key };
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

function assertLiveKitAccessConfiguration(env: Env): void {
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
    throw new Error("LiveKit access configuration is incomplete");
  }
  if (!env.LIVEKIT_URL.startsWith("wss://") || !env.R2_S3_ENDPOINT.startsWith("https://")) {
    throw new Error("LiveKit access URLs are invalid");
  }
}
