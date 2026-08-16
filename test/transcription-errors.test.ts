import { describe, expect, it } from "vitest";

import {
  transcriptionFailure,
  TranscriptionStageError,
} from "../src/worker/transcription/transcription-errors";

describe("transcription failure classification", () => {
  it("classifies a stage error directly", () => {
    expect(
      transcriptionFailure(
        new TranscriptionStageError("inference", "inference_failed", "provider_error"),
      ),
    ).toMatchObject({
      stage: "inference",
      errorCode: "inference_failed",
      category: "provider_error",
    });
  });

  it("preserves classification after Workflow error serialization", () => {
    const original = new TranscriptionStageError("inference", "inference_failed", "provider_error");

    expect(transcriptionFailure(new Error(original.message))).toEqual({
      stage: "inference",
      errorCode: "inference_failed",
      category: "provider_error",
    });
  });

  it("falls back safely for unrelated errors and invalid markers", () => {
    const fallback = {
      stage: "unknown",
      errorCode: "transcription_failed",
      category: "unexpected_error",
    };
    expect(transcriptionFailure(new Error("provider secret"))).toEqual(fallback);
    expect(
      transcriptionFailure(
        new Error(
          "Transcription stage failed [stage=inference;errorCode=made_up;category=provider_error].",
        ),
      ),
    ).toEqual(fallback);
  });
});
