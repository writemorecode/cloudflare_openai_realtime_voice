import { describe, expect, it } from "vitest";

import { addRecordingDurationMetadata } from "../src/recording";
import { WebmContainer } from "../src/vendor/fix-webm-duration/parser/lib/WebmContainer";

const SEGMENT_ID = 0x8538067;
const INFO_ID = 0x549a966;
const TIMECODE_SCALE_ID = 0xad7b1;
const DURATION_ID = 0x489;

function recordingWithoutDuration() {
  return new Blob(
    [
      new Uint8Array([
        0x18, 0x53, 0x80, 0x67, 0x8c, 0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f,
        0x42, 0x40,
      ]),
    ],
    { type: "audio/webm;codecs=opus" },
  );
}

describe("recording finalization", () => {
  it("adds measured duration metadata to WebM recordings", async () => {
    const fixed = await addRecordingDurationMetadata(recordingWithoutDuration(), 12_345);
    const file = new WebmContainer("File");
    file.setSource(new Uint8Array(await fixed.arrayBuffer()));

    const duration = file
      .getSectionById(SEGMENT_ID)
      ?.getSectionById(INFO_ID)
      ?.getSectionById(DURATION_ID)
      ?.getValue();
    const timecodeScale = file
      .getSectionById(SEGMENT_ID)
      ?.getSectionById(INFO_ID)
      ?.getSectionById(TIMECODE_SCALE_ID)
      ?.getValue();

    expect(duration).toBe(12_345);
    expect(timecodeScale).toBe(1_000_000);
  });

  it("does not modify recording formats that carry their own duration", async () => {
    const recording = new Blob(["recording"], { type: "audio/mp4" });

    await expect(addRecordingDurationMetadata(recording, 12_345)).resolves.toBe(recording);
  });

  it("parses float views without changing the recording buffer", () => {
    const source = new Uint8Array([0x44, 0x89, 0x88, 0x40, 0xc8, 0x1c, 0x80, 0, 0, 0, 0]);
    const original = source.slice();
    const container = new WebmContainer("Info");

    container.setSource(source);

    expect(container.getSectionById(DURATION_ID)?.getValue()).toBe(12_345);
    expect(source).toEqual(original);
  });
});
