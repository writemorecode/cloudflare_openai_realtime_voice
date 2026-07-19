import { z } from "zod";

export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1";
export const DEFAULT_REALTIME_VOICE = "marin";

export interface AgentRuntimeConfig {
  readonly openAIApiKey: string;
  readonly realtimeModel: string;
  readonly realtimeVoice: string;
  readonly allowSyntheticMetadata: boolean;
  readonly controlPlaneUrl: string | null;
  readonly callbackToken: string | null;
}

const nonemptySecret = z.string().trim().min(1);
const nonemptySetting = z.string().trim().min(1);

export function readAgentRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): AgentRuntimeConfig {
  const openAIApiKey = nonemptySecret.safeParse(environment.OPENAI_API_KEY);
  if (!openAIApiKey.success) throw new Error("OPENAI_API_KEY is required");

  const realtimeModel = optionalSetting(
    environment.OPENAI_REALTIME_MODEL,
    DEFAULT_REALTIME_MODEL,
    "OPENAI_REALTIME_MODEL",
  );
  const realtimeVoice = optionalSetting(
    environment.OPENAI_REALTIME_VOICE,
    DEFAULT_REALTIME_VOICE,
    "OPENAI_REALTIME_VOICE",
  );

  const syntheticFlag = environment.AGENT_ALLOW_SYNTHETIC_METADATA ?? "false";
  if (syntheticFlag !== "true" && syntheticFlag !== "false") {
    throw new Error("AGENT_ALLOW_SYNTHETIC_METADATA must be true or false");
  }

  return {
    openAIApiKey: openAIApiKey.data,
    realtimeModel,
    realtimeVoice,
    allowSyntheticMetadata: syntheticFlag === "true",
    controlPlaneUrl: optionalUrl(environment.AGENT_CONTROL_PLANE_URL),
    callbackToken: optionalSecret(environment.AGENT_CALLBACK_TOKEN),
  };
}

function optionalUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = z.url({ protocol: /^https?$/ }).safeParse(value);
  if (!parsed.success) throw new Error("AGENT_CONTROL_PLANE_URL must be an HTTP(S) URL");
  return parsed.data.replace(/\/$/, "");
}

function optionalSecret(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = nonemptySecret.safeParse(value);
  if (!parsed.success) throw new Error("AGENT_CALLBACK_TOKEN must not be empty");
  return parsed.data;
}

function optionalSetting(value: string | undefined, fallback: string, name: string): string {
  if (value === undefined) return fallback;
  const parsed = nonemptySetting.safeParse(value);
  if (!parsed.success) throw new Error(`${name} must not be empty`);
  return parsed.data;
}
