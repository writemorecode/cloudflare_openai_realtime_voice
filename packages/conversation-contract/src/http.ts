/** Runtime-validated public HTTP response contracts. */
import { z } from "zod";

/** Validates the authenticated user returned by the session endpoints. */
export const authSessionSchema = z.object({ username: z.string().min(1) });
/** Validates the multipart-upload metadata allocated for a recording. */
export const recordingUploadSchema = z.object({
  recordingId: z.string().min(1),
  objectKey: z.string().min(1),
  uploadId: z.string().min(1),
});
/** Validates an uploaded recording part and its storage ETag. */
export const uploadedRecordingPartSchema = z.object({
  partNumber: z.number().int().positive(),
  etag: z.string().min(1),
});

/** An authenticated browser session. */
export type AuthSession = z.infer<typeof authSessionSchema>;
/** Metadata needed to upload an examination recording in parts. */
export type RecordingUpload = z.infer<typeof recordingUploadSchema>;
/** The completed upload metadata for one recording part. */
export type UploadedRecordingPart = z.infer<typeof uploadedRecordingPartSchema>;
