import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { ConversationStateTag } from "../src/domain/conversation-state-machine";
import { FoundationHarness } from "./harness/foundation-harness";

async function provisionedHarness(key: string): Promise<{
  readonly harness: FoundationHarness;
  readonly conversationId: string;
}> {
  const harness = new FoundationHarness(env);
  const starting = await harness.createStartedConversation(key);
  await harness.provisionConversation(starting.conversationId);
  return { harness, conversationId: starting.conversationId };
}

describe("foundation LiveKit orchestration", () => {
  it("records active egress exactly once across webhook retries", async () => {
    const { harness, conversationId } = await provisionedHarness(
      "foundation-egress-started-deduplication",
    );
    const provisioning = await harness.provisioning(conversationId);
    const payload = {
      event: "egress_started",
      id: harness.nextWebhookId(),
      egressInfo: {
        egressId: provisioning.egressId,
        roomName: provisioning.roomName,
        status: "EGRESS_ACTIVE",
        fileResults: [],
      },
    };

    const first = await harness.webhook(payload);
    const duplicate = await harness.webhook(payload);

    expect(first.status).toBe(204);
    expect(duplicate.status).toBe(204);
    expect(await harness.state(conversationId)).toMatchObject({
      tag: ConversationStateTag.Starting,
      revision: 2,
      data: { artifact: { status: "recording" } },
    });
  });

  it("maps failed egress to a sanitized artifact failure", async () => {
    const { harness, conversationId } = await provisionedHarness("foundation-egress-failure");
    const provisioning = await harness.provisioning(conversationId);
    const response = await harness.webhook({
      event: "egress_ended",
      id: harness.nextWebhookId(),
      egressInfo: {
        egressId: provisioning.egressId,
        roomName: provisioning.roomName,
        status: "EGRESS_FAILED",
        fileResults: [],
      },
    });

    expect(response.status).toBe(204);
    expect(await harness.state(conversationId)).toMatchObject({
      tag: ConversationStateTag.Ending,
      data: {
        artifact: {
          status: "failed",
          errorCode: "artifact.livekit_egress_failed",
        },
        target: {
          kind: "fail",
          errorCode: "artifact.livekit_egress_failed",
        },
      },
    });
    expect(await harness.getConversation(conversationId)).toMatchObject({
      state: "ending",
      artifact: {
        status: "failed",
        errorCode: "artifact.livekit_egress_failed",
      },
    });
  });

  it("rejects egress events that do not match the provisioned recording", async () => {
    const { harness, conversationId } = await provisionedHarness("foundation-egress-correlation");
    const response = await harness.webhook({
      event: "egress_started",
      id: harness.nextWebhookId(),
      egressInfo: {
        egressId: "EG_unrelated",
        roomName: harness.roomName(conversationId),
        status: "EGRESS_ACTIVE",
        fileResults: [],
      },
    });

    expect(response.status).toBe(409);
    expect(await harness.state(conversationId)).toMatchObject({
      tag: ConversationStateTag.Starting,
      revision: 1,
      data: { artifact: { status: "pending" } },
    });
  });

  it("keeps upload pending while the expected recording object is unavailable", async () => {
    const { harness, conversationId } = await provisionedHarness(
      "foundation-recording-not-available",
    );
    await harness.recordingStarted(conversationId);
    await harness.beginEnding(conversationId);
    const provisioning = await harness.provisioning(conversationId);
    const response = await harness.webhook({
      event: "egress_ended",
      id: harness.nextWebhookId(),
      egressInfo: {
        egressId: provisioning.egressId,
        roomName: provisioning.roomName,
        status: "EGRESS_COMPLETE",
        fileResults: [{ filename: provisioning.expectedR2Key, size: "10" }],
      },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(harness.recordings.headCalls).toEqual([provisioning.expectedR2Key]);
    expect(await harness.state(conversationId)).toMatchObject({
      tag: ConversationStateTag.Ending,
      data: {
        artifact: {
          status: "uploading",
          expectedR2Key: provisioning.expectedR2Key,
        },
      },
    });
  });

  it("converges after a partial provider teardown failure", async () => {
    const { harness, conversationId } = await provisionedHarness("foundation-partial-shutdown");
    await harness.beginEnding(conversationId);
    harness.liveKit.failNext("delete_room");

    const failed = await harness.stopConversationResources(conversationId);
    const recovered = await harness.stopConversationResources(conversationId);

    expect(failed.status).toBe(502);
    expect(recovered.status).toBe(204);
    expect(harness.liveKit.count("stop_egress")).toBe(1);
    expect(harness.liveKit.count("delete_dispatch")).toBe(1);
    expect(harness.liveKit.count("delete_room")).toBe(2);
  });
});
