import {
  transition as transitionResult,
  transitionRuntime as transitionRuntimeResult,
  type AllowedEventType,
  type ConversationEvent,
  type ConversationState,
  type NextState,
  type TransitionableState,
} from "../src/domain/conversation-state-machine";

type IsUnion<T, Whole = T> = T extends unknown ? ([Whole] extends [T] ? false : true) : never;
type RequireSingleState<S extends TransitionableState> = true extends IsUnion<S["tag"]> ? never : S;

export function transition<S extends TransitionableState, E extends AllowedEventType<S["tag"]>>(
  state: RequireSingleState<S>,
  event: Extract<ConversationEvent, { type: E }>,
): NextState<S["tag"], E> {
  const result = transitionResult(state, event);
  if (!result.isOk()) {
    throw new Error(
      result.error.kind === "guard_failed"
        ? result.error.reason
        : `illegal transition: ${result.error.state} + ${result.error.event}`,
    );
  }
  return result.value;
}

export function transitionRuntime(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  const result = transitionRuntimeResult(state, event);
  if (!result.isOk()) {
    throw new Error(
      result.error.kind === "guard_failed"
        ? result.error.reason
        : `illegal transition: ${result.error.state} + ${result.error.event}`,
    );
  }
  return result.value;
}
