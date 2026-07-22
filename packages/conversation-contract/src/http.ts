/** Runtime-validated public HTTP response contracts. */
import { z } from "zod";

export const authSessionSchema = z.object({ username: z.string().min(1) });
export const liveKitAccessSchema = z.object({
  roomName: z.string().min(1),
  serverUrl: z.string().url(),
  participantToken: z.string().min(1),
});

export type AuthSession = z.infer<typeof authSessionSchema>;
export type LiveKitAccess = z.infer<typeof liveKitAccessSchema>;
