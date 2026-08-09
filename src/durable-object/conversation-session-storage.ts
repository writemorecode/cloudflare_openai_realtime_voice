import type { ConversationState } from "../domain/conversation-state-machine";
import { Result } from "better-result";

export const SNAPSHOT_KEY = "conversation:snapshot:v1";
export const RECEIPT_KEY_PREFIX = "conversation:receipt:v1:";
export const SNAPSHOT_SCHEMA_VERSION = 2 as const;

export interface PersistedSnapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly state: ConversationState;
}

export interface SnapshotEnvelope {
  readonly schemaVersion: unknown;
  readonly state: ConversationState;
}

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
