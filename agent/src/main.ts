/**
 * Entrypoint for the separately deployed, long-running LiveKit Agent application.
 *
 * This process joins LiveKit rooms and owns the OpenAI Realtime connection. It is not bundled into
 * the Cloudflare Worker and must not import Worker or Durable Object implementation modules.
 */
import { fileURLToPath } from "node:url";

import { type JobContext, ServerOptions, cli, defineAgent, voice } from "@livekit/agents";
import dotenv from "dotenv";

import { createAssistant } from "./assistant.js";
import { readAgentRuntimeConfig } from "./config.js";
import { dispatchMetadataForJob } from "./dispatch-metadata.js";
import { HttpExaminationQuestionClient } from "./examination-client.js";
import { createRealtimeModel } from "./model.js";
import { createLifecycleReporter, NoopAgentLifecycleReporter } from "./reporter.js";
import { BEGIN_EXAMINATION_INSTRUCTIONS, runAgentJob } from "./runtime.js";

export const AGENT_DISPATCH_NAME = "oral-exam-agent";

dotenv.config({ path: fileURLToPath(new URL("../.env.local", import.meta.url)), quiet: true });

export default defineAgent({
  entry: async (ctx: JobContext): Promise<void> => {
    const config = readAgentRuntimeConfig(process.env);
    const metadata = dispatchMetadataForJob(ctx, config.allowSyntheticMetadata);

    const reporter =
      ctx.isFakeJob && config.allowSyntheticMetadata
        ? new NoopAgentLifecycleReporter()
        : createLifecycleReporter(config);
    const examinationClient =
      config.controlPlaneUrl === null || config.callbackToken === null
        ? null
        : new HttpExaminationQuestionClient(config.controlPlaneUrl, config.callbackToken);
    if (!ctx.isFakeJob && examinationClient === null) {
      throw new Error("Agent examination control-plane configuration is required");
    }
    await runAgentJob({
      metadata,
      room: ctx.room,
      connect: async () => ctx.connect(),
      createSession: (observer) =>
        new voice.AgentSession({ llm: createRealtimeModel(config, observer) }),
      createAssistant: () =>
        examinationClient === null
          ? createAssistant()
          : createAssistant({ client: examinationClient, conversationId: metadata.conversationId }),
      reporter,
      ...(examinationClient === null
        ? {}
        : {
            initialReplyInstructions: BEGIN_EXAMINATION_INSTRUCTIONS,
            requireInitialTool: true,
          }),
      registerShutdownCallback: (callback) => ctx.addShutdownCallback(callback),
      onBackgroundReportError: (error) => {
        console.error(
          JSON.stringify({ kind: "agent_lifecycle_report_failed", error: String(error) }),
        );
      },
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_DISPATCH_NAME,
  }),
);
