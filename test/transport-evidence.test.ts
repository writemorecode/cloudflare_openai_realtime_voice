import { describe, expect, it } from "vitest";

import {
  emptyTransportEvidence,
  updateMediaEvidence,
} from "../src/durable-object/transport-evidence";

describe("LiveKit transport evidence", () => {
  it("does not carry audio evidence across an agent participant replacement", () => {
    const original = updateMediaEvidence(
      updateMediaEvidence(emptyTransportEvidence(1), "agent_participant_joined", "agent-a"),
      "agent_audio_published",
      "agent-a",
    );

    expect(original).toMatchObject({
      agentParticipantActive: true,
      agentParticipantIdentity: "agent-a",
      agentAudioPublished: true,
    });

    expect(updateMediaEvidence(original, "agent_participant_joined", "agent-b")).toMatchObject({
      agentParticipantActive: true,
      agentParticipantIdentity: "agent-b",
      agentAudioPublished: false,
    });
  });

  it("retains audio evidence when the same agent participant is reported again", () => {
    const evidence = updateMediaEvidence(
      updateMediaEvidence(emptyTransportEvidence(1), "agent_participant_joined", "agent-a"),
      "agent_audio_published",
      "agent-a",
    );

    expect(updateMediaEvidence(evidence, "agent_participant_joined", "agent-a")).toMatchObject({
      agentAudioPublished: true,
    });
  });
});
