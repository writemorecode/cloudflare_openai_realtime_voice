/** Finalizes browser-recorded audio containers before they are uploaded. */
import { fixWebmDuration } from "./vendor/fix-webm-duration/fix/lib/fixWebmDuration";

/** Adds the duration metadata omitted from WebM files produced by MediaRecorder. */
export async function addRecordingDurationMetadata(
  recording: Blob,
  durationMs: number,
): Promise<Blob> {
  if (!recording.type.toLowerCase().startsWith("audio/webm")) return recording;
  return fixWebmDuration(recording, durationMs, { logger: false });
}
