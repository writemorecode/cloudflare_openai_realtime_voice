/** Runtime-validated public HTTP response contracts. */
import { z } from "zod";

export const authSessionSchema = z.object({ username: z.string().min(1) });
export const recordingUploadSchema = z.object({
  recordingId: z.string().min(1),
  objectKey: z.string().min(1),
  uploadId: z.string().min(1),
});
export const uploadedRecordingPartSchema = z.object({
  partNumber: z.number().int().positive(),
  etag: z.string().min(1),
});

export type AuthSession = z.infer<typeof authSessionSchema>;
export type RecordingUpload = z.infer<typeof recordingUploadSchema>;
export type UploadedRecordingPart = z.infer<typeof uploadedRecordingPartSchema>;
