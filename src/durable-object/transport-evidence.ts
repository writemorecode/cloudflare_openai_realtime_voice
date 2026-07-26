import type {
  LiveKitMediaObservationKind,
  LiveKitTransportEvidence,
} from "./conversation-session-contract";

export function emptyTransportEvidence(transportEpoch: number): LiveKitTransportEvidence {
  return {
    transportEpoch,
    browserParticipantActive: false,
    browserAudioPublished: false,
    agentParticipantActive: false,
    agentParticipantIdentity: null,
    agentAudioPublished: false,
    realtimeReady: false,
    realtimeReadyEventId: null,
  };
}

export function updateMediaEvidence(
  current: LiveKitTransportEvidence,
  kind: LiveKitMediaObservationKind,
  participantIdentity: string,
): LiveKitTransportEvidence {
  switch (kind) {
    case "browser_participant_joined":
      return { ...current, browserParticipantActive: true };
    case "browser_participant_left":
      return { ...current, browserParticipantActive: false, browserAudioPublished: false };
    case "browser_audio_published":
      return { ...current, browserAudioPublished: true };
    case "browser_audio_unpublished":
      return { ...current, browserAudioPublished: false };
    case "agent_participant_joined":
      return {
        ...current,
        agentParticipantActive: true,
        agentParticipantIdentity: participantIdentity,
        agentAudioPublished:
          current.agentParticipantIdentity === participantIdentity
            ? current.agentAudioPublished
            : false,
      };
    case "agent_participant_left":
      if (current.agentParticipantIdentity !== participantIdentity) return current;
      return {
        ...current,
        agentParticipantActive: false,
        agentParticipantIdentity: null,
        agentAudioPublished: false,
      };
    case "agent_audio_published":
      if (current.agentParticipantIdentity !== participantIdentity) return current;
      return { ...current, agentAudioPublished: true };
    case "agent_audio_unpublished":
      if (current.agentParticipantIdentity !== participantIdentity) return current;
      return { ...current, agentAudioPublished: false };
  }
}
