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
import { createRealtimeModel } from "./model.js";
import { createLifecycleReporter, NoopAgentLifecycleReporter } from "./reporter.js";
import { runAgentJob } from "./runtime.js";

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
    await runAgentJob({
      metadata,
      room: ctx.room,
      connect: async () => ctx.connect(),
      createSession: (observer) =>
        new voice.AgentSession({ llm: createRealtimeModel(config, observer) }),
      createAssistant,
      reporter,
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
