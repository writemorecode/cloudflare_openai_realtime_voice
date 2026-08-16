import { describe, expect, it } from "vitest";

import { presignRecordingGet } from "../src/worker/transcription/presigned-recording-url";

const configuration = {
  accountId: "0123456789abcdef0123456789abcdef",
  bucketName: "private-recordings",
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
};

describe("R2 recording presigning", () => {
  it("creates an HTTPS S3 GET URL with a fifteen-minute expiry", async () => {
    const signed = new URL(
      await presignRecordingGet(
        configuration,
        "conversations/123e4567-e89b-42d3-a456-426614174000/recording.webm",
      ),
    );

    expect(signed.protocol).toBe("https:");
    expect(signed.hostname).toBe("0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    expect(signed.pathname).toBe(
      "/private-recordings/conversations/123e4567-e89b-42d3-a456-426614174000/recording.webm",
    );
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(signed.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses to sign transcript or unrelated object keys", async () => {
    await expect(
      presignRecordingGet(configuration, "conversations/id/transcript.v1.json"),
    ).rejects.toThrow("non-recording");
  });
});
