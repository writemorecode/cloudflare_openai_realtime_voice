/** Creates authenticated OpenAI Realtime WebRTC calls without exposing the API key. */
import { Result } from "better-result";

import type { AuthenticatedUser } from "../http/browser-auth";
import { ApiError } from "../http/api-errors";

const MAX_SDP_BYTES = 64 * 1024;
const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

const examinerInstructions = `You are a calm, neutral academic oral examiner. Never grade the student.
At the beginning call get_current_examination_question, then ask the returned fixed question exactly.
Use concise, non-leading follow-ups only to gather useful evidence. When a question is finished, call
complete_current_examination_question with the returned questionId and revision, then ask the next
fixed question returned by the tool. Never invent, reorder, or skip fixed questions. When all questions
are complete, give a brief neutral closing. Keep spoken turns short.`;

const tools = [
  {
    type: "function",
    name: "get_current_examination_question",
    description: "Get the authoritative current fixed examination question and progress.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "complete_current_examination_question",
    description:
      "Mark the current fixed question complete after sufficient evidence, and get the next question.",
    parameters: {
      type: "object",
      properties: {
        questionId: { type: "string", description: "Current question UUID returned by the tool." },
        expectedRevision: {
          type: "integer",
          description: "Current question revision returned by the tool.",
        },
        disposition: {
          type: "string",
          enum: ["answered", "answered_after_follow_up", "unable_to_answer"],
        },
      },
      required: ["questionId", "expectedRevision", "disposition"],
      additionalProperties: false,
    },
  },
] as const;

export async function createRealtimeCall(
  request: Request,
  user: AuthenticatedUser,
  env: Env,
): Promise<Result<Response, ApiError>> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !== "application/sdp") {
    return Result.err(
      new ApiError(415, "unsupported_media_type", "Content-Type must be application/sdp."),
    );
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_SDP_BYTES) {
    return Result.err(new ApiError(413, "sdp_too_large", "The SDP offer is too large."));
  }
  const offer = await Result.tryPromise({
    try: () => request.arrayBuffer(),
    catch: (cause) =>
      new ApiError(400, "invalid_sdp", "The SDP offer could not be read.", {}, cause),
  });
  if (!offer.isOk()) return offer;
  if (offer.value.byteLength === 0 || offer.value.byteLength > MAX_SDP_BYTES) {
    return Result.err(new ApiError(400, "invalid_sdp", "The SDP offer is invalid."));
  }

  const form = new FormData();
  form.set("sdp", new TextDecoder().decode(offer.value));
  form.set(
    "session",
    JSON.stringify({
      type: "realtime",
      model: env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1",
      instructions: examinerInstructions,
      audio: { output: { voice: env.OPENAI_REALTIME_VOICE || "marin" } },
      tools,
      tool_choice: "auto",
    }),
  );

  const safetyIdentifier = await sha256Hex(`oral-exam-user:${user.id}`);
  const response = await Result.tryPromise({
    try: () =>
      fetch(REALTIME_CALLS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "OpenAI-Safety-Identifier": safetyIdentifier,
        },
        body: form,
      }),
    catch: (cause) =>
      new ApiError(
        502,
        "realtime_connection_failed",
        "The examiner connection could not be created.",
        {},
        cause,
      ),
  });
  if (!response.isOk()) return response;
  if (!response.value.ok) {
    await response.value.body?.cancel();
    return Result.err(
      new ApiError(
        502,
        "realtime_connection_failed",
        "The examiner connection could not be created.",
        {},
        new Error(`OpenAI Realtime returned ${response.value.status}.`),
      ),
    );
  }
  return Result.ok(
    new Response(response.value.body, {
      status: 200,
      headers: { "Content-Type": "application/sdp", "Cache-Control": "no-store" },
    }),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
