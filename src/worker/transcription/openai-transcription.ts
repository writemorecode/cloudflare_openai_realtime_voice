import { Result } from "better-result";

import { TRANSCRIPTION_MODEL } from "./transcript-artifacts";

// OpenAI's transcription API rejects files larger than 25 MB. Use decimal MB so
// the Worker rejects conservatively before buffering or uploading the object.
export const MAXIMUM_TRANSCRIPTION_FILE_BYTES = 25_000_000;

export function isSupportedTranscriptionFileSize(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0 && size <= MAXIMUM_TRANSCRIPTION_FILE_BYTES;
}

interface OpenAiGatewayConfiguration {
  readonly accountId: string;
  readonly gatewayId: string;
  readonly gatewayToken: string;
}

interface RecordingBody {
  readonly httpMetadata?: { readonly contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export async function requestOpenAiTranscription(
  configuration: OpenAiGatewayConfiguration,
  objectKey: string,
  recording: RecordingBody,
) {
  const contentType = recording.httpMetadata?.contentType ?? "application/octet-stream";
  const filename = objectKey.split("/").at(-1) ?? "recording.webm";
  const file = new Blob([await recording.arrayBuffer()], { type: contentType });
  const body = new FormData();
  body.append("file", file, filename);
  body.append("model", TRANSCRIPTION_MODEL);
  body.append("response_format", "diarized_json");
  body.append("chunking_strategy", "auto");

  const accountId = encodeURIComponent(configuration.accountId);
  const gatewayId = encodeURIComponent(configuration.gatewayId);
  const response = await fetch(
    `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openai/audio/transcriptions`,
    {
      method: "POST",
      headers: {
        "cf-aig-authorization": `Bearer ${configuration.gatewayToken}`,
        "cf-aig-collect-log": "true",
        "cf-aig-skip-cache": "true",
      },
      body,
    },
  );
  if (!response.ok) {
    return Result.err(
      new Error(`OpenAI transcription request failed with HTTP ${response.status}.`),
    );
  }
  return Result.tryPromise({ try: () => response.json(), catch: (cause) => cause });
}
