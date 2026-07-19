/** Defines the concise voice-assistant instructions and constructs the LiveKit assistant. */
import { voice } from "@livekit/agents";

export const ASSISTANT_INSTRUCTIONS = [
  "You are a helpful English-speaking voice assistant.",
  "Be friendly, clear, and concise because the user is listening rather than reading.",
  "Ask at most one question at a time and handle interruptions gracefully.",
  "Do not claim to have performed actions or accessed information that you do not have.",
].join(" ");

export function createAssistant(): voice.Agent {
  return voice.Agent.create({ instructions: ASSISTANT_INSTRUCTIONS });
}
