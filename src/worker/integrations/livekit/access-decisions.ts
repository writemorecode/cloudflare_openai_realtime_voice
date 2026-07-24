/** Pure resource-selection rules for idempotent LiveKit provisioning. */
import type { LiveKitDispatchResource, LiveKitEgressResource } from "../../ports/foundation";
import { err, ok, type Result } from "@ai-oral-exam/result";

const LIVEKIT_AGENT_NAME = "oral-exam-agent";

export interface LiveKitProvisioningDescriptor {
  readonly metadata: string;
  readonly expectedR2Key: string;
}

export type LiveKitResourceDecision<T> =
  | Readonly<{ kind: "create" }>
  | Readonly<{ kind: "reuse"; resource: T }>;

export type LiveKitResourceDecisionError =
  | "dispatch_conflict"
  | "dispatch_invalid"
  | "egress_conflict"
  | "egress_invalid";

export function describeLiveKitProvisioning(
  conversationId: string,
  roomName: string,
  transportEpoch: number,
): LiveKitProvisioningDescriptor {
  return {
    metadata: JSON.stringify({ version: 1, conversationId, roomName, transportEpoch }),
    expectedR2Key: `conversations/${conversationId}/recording.ogg`,
  };
}

export function decideLiveKitDispatch(
  dispatches: readonly LiveKitDispatchResource[],
  metadata: string,
): Result<LiveKitResourceDecision<LiveKitDispatchResource>, LiveKitResourceDecisionError> {
  const matching = dispatches.filter(
    (dispatch) => dispatch.agentName === LIVEKIT_AGENT_NAME && dispatch.metadata === metadata,
  );
  if (matching.length > 1) return err("dispatch_conflict");
  const dispatch = matching[0];
  if (dispatch === undefined) return ok({ kind: "create" });
  return validLiveKitDispatch(dispatch).ok
    ? ok({ kind: "reuse", resource: dispatch })
    : err("dispatch_invalid");
}

export function decideLiveKitEgress(
  activeEgress: readonly LiveKitEgressResource[],
): Result<LiveKitResourceDecision<LiveKitEgressResource>, LiveKitResourceDecisionError> {
  if (activeEgress.length > 1) return err("egress_conflict");
  const egress = activeEgress[0];
  if (egress === undefined) return ok({ kind: "create" });
  return validLiveKitEgress(egress).ok
    ? ok({ kind: "reuse", resource: egress })
    : err("egress_invalid");
}

export function validLiveKitDispatch(
  dispatch: LiveKitDispatchResource,
): Result<LiveKitDispatchResource, LiveKitResourceDecisionError> {
  return dispatch.id.length === 0 ? err("dispatch_invalid") : ok(dispatch);
}

export function validLiveKitEgress(
  egress: LiveKitEgressResource,
): Result<LiveKitEgressResource, LiveKitResourceDecisionError> {
  return egress.egressId.length === 0 ? err("egress_invalid") : ok(egress);
}
