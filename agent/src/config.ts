/** Parses and validates the environment configuration for the long-running agent process. */
import { Result } from "better-result";
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

export interface AgentRuntimeConfigError {
  readonly code:
    | "missing_openai_api_key"
    | "invalid_synthetic_metadata_flag"
    | "invalid_control_plane_url"
    | "invalid_callback_token"
    | "invalid_setting";
  readonly message: string;
}

const nonemptySecret = z.string().trim().min(1);
const nonemptySetting = z.string().trim().min(1);

export function readAgentRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): Result<AgentRuntimeConfig, AgentRuntimeConfigError> {
  const openAIApiKey = nonemptySecret.safeParse(environment.OPENAI_API_KEY);
  if (!openAIApiKey.success) {
    return Result.err({ code: "missing_openai_api_key", message: "OPENAI_API_KEY is required" });
  }

  const realtimeModel = optionalSetting(
    environment.OPENAI_REALTIME_MODEL,
    DEFAULT_REALTIME_MODEL,
    "OPENAI_REALTIME_MODEL",
  );
  if (!realtimeModel.isOk()) return realtimeModel;
  const realtimeVoice = optionalSetting(
    environment.OPENAI_REALTIME_VOICE,
    DEFAULT_REALTIME_VOICE,
    "OPENAI_REALTIME_VOICE",
  );
  if (!realtimeVoice.isOk()) return realtimeVoice;

  const syntheticFlag = environment.AGENT_ALLOW_SYNTHETIC_METADATA ?? "false";
  if (syntheticFlag !== "true" && syntheticFlag !== "false") {
    return Result.err({
      code: "invalid_synthetic_metadata_flag",
      message: "AGENT_ALLOW_SYNTHETIC_METADATA must be true or false",
    });
  }

  const controlPlaneUrl = optionalUrl(environment.AGENT_CONTROL_PLANE_URL);
  if (!controlPlaneUrl.isOk()) return controlPlaneUrl;
  const callbackToken = optionalSecret(environment.AGENT_CALLBACK_TOKEN);
  if (!callbackToken.isOk()) return callbackToken;

  return Result.ok({
    openAIApiKey: openAIApiKey.data,
    realtimeModel: realtimeModel.value,
    realtimeVoice: realtimeVoice.value,
    allowSyntheticMetadata: syntheticFlag === "true",
    controlPlaneUrl: controlPlaneUrl.value,
    callbackToken: callbackToken.value,
  });
}

function optionalUrl(value: string | undefined): Result<string | null, AgentRuntimeConfigError> {
  if (value === undefined) return Result.ok(null);
  const parsed = z.url({ protocol: /^https?$/ }).safeParse(value);
  if (!parsed.success) {
    return Result.err({
      code: "invalid_control_plane_url",
      message: "AGENT_CONTROL_PLANE_URL must be an HTTP(S) URL",
    });
  }
  return Result.ok(parsed.data.replace(/\/$/, ""));
}

function optionalSecret(value: string | undefined): Result<string | null, AgentRuntimeConfigError> {
  if (value === undefined) return Result.ok(null);
  const parsed = nonemptySecret.safeParse(value);
  if (!parsed.success) {
    return Result.err({
      code: "invalid_callback_token",
      message: "AGENT_CALLBACK_TOKEN must not be empty",
    });
  }
  return Result.ok(parsed.data);
}

function optionalSetting(
  value: string | undefined,
  fallback: string,
  name: string,
): Result<string, AgentRuntimeConfigError> {
  if (value === undefined) return Result.ok(fallback);
  const parsed = nonemptySetting.safeParse(value);
  if (!parsed.success) {
    return Result.err({ code: "invalid_setting", message: `${name} must not be empty` });
  }
  return Result.ok(parsed.data);
}
