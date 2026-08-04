/** LiveKit SDK adapters for the foundation's provider ports. */
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
  WebhookReceiver,
} from "livekit-server-sdk";

import type {
  LiveKitControlPort,
  LiveKitEgressResource,
  LiveKitWebhookVerifier,
} from "../ports/foundation";

const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
const ROOM_EMPTY_TIMEOUT_SECONDS = 5 * 60;
const ROOM_DEPARTURE_TIMEOUT_SECONDS = 30;
const LIVEKIT_AGENT_NAME = "oral-exam-agent";

export function liveKitWebhookVerifier(env: Env): LiveKitWebhookVerifier {
  const receiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  return {
    verify: (rawBody, authorization) => receiver.receive(rawBody, authorization),
  };
}

export function liveKitControlPort(env: Env): LiveKitControlPort {
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
    listActiveEgress: async (roomName) =>
      (await egressClient.listEgress({ roomName, active: true })).map(toEgressResource),
    startEgress: async (roomName, objectKey) =>
      toEgressResource(
        await egressClient.startRoomCompositeEgress(
          roomName,
          new EncodedFileOutput({
            fileType: EncodedFileType.OGG,
            filepath: objectKey,
            output: {
              case: "s3",
              value: new S3Upload({
                accessKey: env.R2_ACCESS_KEY_ID,
                secret: env.R2_SECRET_ACCESS_KEY,
                endpoint: env.R2_ENDPOINT,
                bucket: env.R2_BUCKET_NAME,
                forcePathStyle: true,
              }),
            },
          }),
          { audioOnly: true },
        ),
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
    getEgress: async (egressId) => {
      const egress = (await egressClient.listEgress({ egressId }))[0];
      return egress === undefined ? undefined : toEgressResource(egress);
    },
    stopEgress: async (egressId) => {
      await egressClient.stopEgress(egressId);
    },
    getDispatch: async (dispatchId, roomName) =>
      (await dispatchClient.listDispatch(roomName)).find((dispatch) => dispatch.id === dispatchId),
    deleteDispatch: async (dispatchId, roomName) =>
      dispatchClient.deleteDispatch(dispatchId, roomName),
    deleteRoom: async (roomName) => roomClient.deleteRoom(roomName),
  };
}

function toEgressResource(egress: {
  readonly egressId: string;
  readonly status: EgressStatus;
}): LiveKitEgressResource {
  return {
    egressId: egress.egressId,
    active:
      egress.status === EgressStatus.EGRESS_STARTING ||
      egress.status === EgressStatus.EGRESS_ACTIVE,
  };
}
