import { ConversationStateTag, TransportStatus } from "../domain/conversation-state-machine";
import type {
  BeginLiveKitProvisioningCommand,
  BeginLiveKitProvisioningResult,
  BeginLiveKitShutdownCommand,
  BeginLiveKitShutdownResult,
  CompleteLiveKitProvisioningCommand,
  CompleteLiveKitShutdownCommand,
  LiveKitProvisioningReady,
  LiveKitTransportEvidence,
  RecordAgentObservationCommand,
  RecordLiveKitMediaObservationCommand,
  RecordObservationResult,
} from "./conversation-session-contract";
import {
  AGENT_OBSERVATION_RECEIPT_PREFIX,
  LIVEKIT_MEDIA_RECEIPT_PREFIX,
  LIVEKIT_PROVISIONING_KEY,
  LIVEKIT_SHUTDOWN_KEY,
  LIVEKIT_TRANSPORT_EVIDENCE_KEY,
  SNAPSHOT_KEY,
  decodeSnapshot,
  type LiveKitProvisioning,
  type LiveKitProvisioningLease,
  type LiveKitShutdown,
  type LiveKitShutdownComplete,
  type LiveKitShutdownLease,
  type PersistedSnapshot,
} from "./conversation-session-storage";
import { emptyTransportEvidence, updateMediaEvidence } from "./transport-evidence";

/** Owns provider-correlation state that must remain consistent with one conversation aggregate. */
export class LiveKitCoordinationStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  beginProvisioning(
    command: BeginLiveKitProvisioningCommand,
  ): Promise<BeginLiveKitProvisioningResult> {
    return this.storage.transaction(async (transaction) => {
      const state = decodeSnapshot(await transaction.get<PersistedSnapshot>(SNAPSHOT_KEY));
      if (state?.tag !== ConversationStateTag.Starting) {
        return { outcome: "rejected", reason: "not_starting" } as const;
      }
      const transport = state.data.transport;
      if (
        transport.status !== TransportStatus.Connecting ||
        transport.epoch !== command.transportEpoch
      ) {
        return { outcome: "rejected", reason: "epoch_mismatch" } as const;
      }

      const current = await transaction.get<LiveKitProvisioning>(LIVEKIT_PROVISIONING_KEY);
      if (current?.status === "ready") {
        return current.roomName === command.roomName &&
          current.transportEpoch === command.transportEpoch
          ? ({ outcome: "ready", provisioning: current } as const)
          : ({ outcome: "rejected", reason: "epoch_mismatch" } as const);
      }
      if (current?.status === "provisioning" && current.leaseExpiresAt > command.now) {
        return { outcome: "in_progress", retryAt: current.leaseExpiresAt } as const;
      }

      await transaction.put(LIVEKIT_PROVISIONING_KEY, {
        status: "provisioning",
        roomName: command.roomName,
        transportEpoch: command.transportEpoch,
        leaseId: command.leaseId,
        leaseExpiresAt: command.leaseExpiresAt,
      } satisfies LiveKitProvisioningLease);
      return { outcome: "owner", leaseId: command.leaseId } as const;
    });
  }

  completeProvisioning(command: CompleteLiveKitProvisioningCommand): Promise<boolean> {
    return this.storage.transaction(async (transaction) => {
      const current = await transaction.get<LiveKitProvisioning>(LIVEKIT_PROVISIONING_KEY);
      if (
        current?.status !== "provisioning" ||
        current.leaseId !== command.leaseId ||
        current.roomName !== command.roomName ||
        current.transportEpoch !== command.transportEpoch
      ) {
        return false;
      }
      const ready: LiveKitProvisioningReady = {
        status: "ready",
        roomName: command.roomName,
        transportEpoch: command.transportEpoch,
        dispatchId: command.dispatchId,
        egressId: command.egressId,
        expectedR2Key: command.expectedR2Key,
      };
      await transaction.put(LIVEKIT_PROVISIONING_KEY, ready);
      return true;
    });
  }

  async abandonProvisioning(leaseId: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<LiveKitProvisioning>(LIVEKIT_PROVISIONING_KEY);
      if (current?.status === "provisioning" && current.leaseId === leaseId) {
        await transaction.delete(LIVEKIT_PROVISIONING_KEY);
      }
    });
  }

  async getProvisioning(): Promise<LiveKitProvisioningReady | null> {
    const current = await this.storage.get<LiveKitProvisioning>(LIVEKIT_PROVISIONING_KEY);
    return current?.status === "ready" ? current : null;
  }

  beginShutdown(command: BeginLiveKitShutdownCommand): Promise<BeginLiveKitShutdownResult> {
    return this.storage.transaction(async (transaction) => {
      const state = decodeSnapshot(await transaction.get<PersistedSnapshot>(SNAPSHOT_KEY));
      if (
        state === null ||
        state.tag === ConversationStateTag.Created ||
        state.tag === ConversationStateTag.Starting ||
        state.tag === ConversationStateTag.Live
      ) {
        return { outcome: "rejected", reason: "conversation_active" } as const;
      }
      const provisioning = await transaction.get<LiveKitProvisioning>(LIVEKIT_PROVISIONING_KEY);
      if (provisioning?.status !== "ready") {
        return { outcome: "rejected", reason: "not_provisioned" } as const;
      }
      const current = await transaction.get<LiveKitShutdown>(LIVEKIT_SHUTDOWN_KEY);
      if (current?.status === "stopped") return { outcome: "stopped" } as const;
      if (current?.status === "stopping" && current.leaseExpiresAt > command.now) {
        return { outcome: "in_progress", retryAt: current.leaseExpiresAt } as const;
      }
      await transaction.put(LIVEKIT_SHUTDOWN_KEY, {
        status: "stopping",
        leaseId: command.leaseId,
        leaseExpiresAt: command.leaseExpiresAt,
      } satisfies LiveKitShutdownLease);
      return { outcome: "owner", provisioning } as const;
    });
  }

  completeShutdown(command: CompleteLiveKitShutdownCommand): Promise<boolean> {
    return this.storage.transaction(async (transaction) => {
      const current = await transaction.get<LiveKitShutdown>(LIVEKIT_SHUTDOWN_KEY);
      if (current?.status !== "stopping" || current.leaseId !== command.leaseId) return false;
      await transaction.put(LIVEKIT_SHUTDOWN_KEY, {
        status: "stopped",
        stoppedAt: command.stoppedAt,
      } satisfies LiveKitShutdownComplete);
      return true;
    });
  }

  async abandonShutdown(leaseId: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<LiveKitShutdown>(LIVEKIT_SHUTDOWN_KEY);
      if (current?.status === "stopping" && current.leaseId === leaseId) {
        await transaction.delete(LIVEKIT_SHUTDOWN_KEY);
      }
    });
  }

  recordAgentObservation(command: RecordAgentObservationCommand): Promise<RecordObservationResult> {
    return this.storage.transaction(async (transaction) => {
      const provisioning = await transaction.get<LiveKitProvisioning>(LIVEKIT_PROVISIONING_KEY);
      if (provisioning?.status !== "ready") {
        return { outcome: "rejected", reason: "not_provisioned" } as const;
      }
      if (provisioning.roomName !== command.roomName) {
        return { outcome: "rejected", reason: "room_mismatch" } as const;
      }
      const receiptKey = `${AGENT_OBSERVATION_RECEIPT_PREFIX}${command.eventId}`;
      if ((await transaction.get<boolean>(receiptKey)) === true) {
        return { outcome: "duplicate" } as const;
      }

      const current =
        (await transaction.get<LiveKitTransportEvidence>(LIVEKIT_TRANSPORT_EVIDENCE_KEY)) ??
        emptyTransportEvidence(provisioning.transportEpoch);
      const advancesRecoveryEpoch =
        command.kind === "realtime_recovered" &&
        command.transportEpoch === current.transportEpoch + 1;
      if (current.transportEpoch !== command.transportEpoch && !advancesRecoveryEpoch) {
        return { outcome: "rejected", reason: "epoch_mismatch" } as const;
      }
      const realtimeReady =
        command.kind === "realtime_ready" || command.kind === "realtime_recovered";
      await transaction.put(LIVEKIT_TRANSPORT_EVIDENCE_KEY, {
        ...current,
        transportEpoch: command.transportEpoch,
        realtimeReady,
        realtimeReadyEventId: realtimeReady ? command.eventId : null,
      } satisfies LiveKitTransportEvidence);
      await transaction.put(receiptKey, true);
      return { outcome: "recorded" } as const;
    });
  }

  async getTransportEvidence(): Promise<LiveKitTransportEvidence | null> {
    return (
      (await this.storage.get<LiveKitTransportEvidence>(LIVEKIT_TRANSPORT_EVIDENCE_KEY)) ?? null
    );
  }

  recordMediaObservation(
    command: RecordLiveKitMediaObservationCommand,
  ): Promise<RecordObservationResult> {
    return this.storage.transaction(async (transaction) => {
      const provisioning = await transaction.get<LiveKitProvisioning>(LIVEKIT_PROVISIONING_KEY);
      if (provisioning?.status !== "ready") {
        return { outcome: "rejected", reason: "not_provisioned" } as const;
      }
      if (provisioning.roomName !== command.roomName) {
        return { outcome: "rejected", reason: "room_mismatch" } as const;
      }
      const receiptKey = `${LIVEKIT_MEDIA_RECEIPT_PREFIX}${command.eventId}`;
      if ((await transaction.get<boolean>(receiptKey)) === true) {
        return { outcome: "duplicate" } as const;
      }

      const current =
        (await transaction.get<LiveKitTransportEvidence>(LIVEKIT_TRANSPORT_EVIDENCE_KEY)) ??
        emptyTransportEvidence(provisioning.transportEpoch);
      if (current.transportEpoch !== command.transportEpoch) {
        return { outcome: "rejected", reason: "epoch_mismatch" } as const;
      }
      const next = updateMediaEvidence(current, command.kind, command.participantIdentity);
      await transaction.put(LIVEKIT_TRANSPORT_EVIDENCE_KEY, next);
      await transaction.put(receiptKey, true);
      return { outcome: "recorded" } as const;
    });
  }
}
