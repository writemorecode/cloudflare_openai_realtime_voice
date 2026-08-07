/**
 * Entrypoint for the separately deployed, long-running LiveKit Agent application.
 *
 * This process joins LiveKit rooms and owns the OpenAI Realtime connection. It is not bundled into
 * the Cloudflare Worker and must not import Worker or Durable Object implementation modules.
 */
import { fileURLToPath } from "node:url";

import { Result } from "better-result";
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
    const configResult = readAgentRuntimeConfig(process.env);
    if (!configResult.isOk()) {
      console.error(configResult.error.message);
      return;
    }
    const config = configResult.value;
    const metadataResult = dispatchMetadataForJob(ctx, config.allowSyntheticMetadata);
    if (!metadataResult.isOk()) {
      console.error(metadataResult.error.message);
      return;
    }
    const metadata = metadataResult.value;

    const reporterResult =
      ctx.isFakeJob && config.allowSyntheticMetadata
        ? Result.ok(new NoopAgentLifecycleReporter())
        : createLifecycleReporter(config);
    if (!reporterResult.isOk()) {
      console.error(reporterResult.error.message);
      return;
    }
    const reporter = reporterResult.value;
    const examinationClient =
      config.controlPlaneUrl === null || config.callbackToken === null
        ? null
        : new HttpExaminationQuestionClient(config.controlPlaneUrl, config.callbackToken);
    if (!ctx.isFakeJob && examinationClient === null) {
      console.error("Agent examination control-plane configuration is required");
      return;
    }
    const jobResult = await runAgentJob({
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
    if (!jobResult.isOk()) console.error(jobResult.error.code);
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_DISPATCH_NAME,
  }),
);
