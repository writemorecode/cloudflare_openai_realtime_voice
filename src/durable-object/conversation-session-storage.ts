import type { ConversationState } from "../domain/conversation-state-machine";
import type { LiveKitProvisioningReady } from "./conversation-session-contract";
import { Result } from "better-result";

export const SNAPSHOT_KEY = "conversation:snapshot:v1";
export const RECEIPT_KEY_PREFIX = "conversation:receipt:v1:";
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const LIVEKIT_PROVISIONING_KEY = "conversation:livekit-provisioning:v1";
export const LIVEKIT_TRANSPORT_EVIDENCE_KEY = "conversation:livekit-transport-evidence:v1";
export const AGENT_OBSERVATION_RECEIPT_PREFIX = "conversation:agent-observation:v1:";
export const LIVEKIT_MEDIA_RECEIPT_PREFIX = "conversation:livekit-media-observation:v1:";
export const LIVEKIT_SHUTDOWN_KEY = "conversation:livekit-shutdown:v1";
export const LIVEKIT_SHUTDOWN_OUTBOX_KEY = "conversation:livekit-shutdown-outbox:v1";

export interface PersistedSnapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly state: ConversationState;
}

export interface SnapshotEnvelope {
  readonly schemaVersion: unknown;
  readonly state: ConversationState;
}

export interface LiveKitProvisioningLease {
  readonly status: "provisioning";
  readonly roomName: string;
  readonly transportEpoch: number;
  readonly leaseId: string;
  readonly leaseExpiresAt: number;
}

export type LiveKitProvisioning = LiveKitProvisioningReady | LiveKitProvisioningLease;

export interface LiveKitShutdownLease {
  readonly status: "stopping";
  readonly leaseId: string;
  readonly leaseExpiresAt: number;
}

export interface LiveKitShutdownComplete {
  readonly status: "stopped";
  readonly stoppedAt: number;
}

export type LiveKitShutdown = LiveKitShutdownLease | LiveKitShutdownComplete;

export interface UnsupportedSnapshotVersionError {
  readonly kind: "unsupported_snapshot_version";
  readonly schemaVersion: unknown;
}

export function decodeSnapshot(
  snapshot: SnapshotEnvelope | undefined,
): Result<ConversationState | null, UnsupportedSnapshotVersionError> {
  if (snapshot === undefined) return Result.ok(null);
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return Result.err({
      kind: "unsupported_snapshot_version",
      schemaVersion: snapshot.schemaVersion,
    });
  }
  return Result.ok(snapshot.state);
}

export function receiptKey(eventId: string): string {
  return `${RECEIPT_KEY_PREFIX}${eventId}`;
}
