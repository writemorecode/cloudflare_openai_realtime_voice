/* oxlint-disable eslint-js/no-restricted-syntax -- Invalid media returns the original Blob. */
import type { Options } from "../../parser/lib/Options";
import { WebmFile } from "../../parser/lib/WebmFile";
import { fixParsedWebmDuration } from "./fixParsedWebmDuration";

export const fixWebmDuration = async (
  blob: Blob,
  duration: number,
  options?: Options,
): Promise<Blob> => {
  try {
    const file = await WebmFile.fromBlob(blob);
    if (fixParsedWebmDuration(file, duration, options)) {
      return file.toBlob(blob.type);
    }
  } catch (cause) {
    if (options?.logger) {
      const message = cause instanceof Error ? cause.message : "Unknown parser failure";
      options.logger(`[fix-webm-duration] ${message}`);
    }
  }

  return blob;
};
