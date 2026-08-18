/** Runtime-validated, provider-neutral transcript contract shared by the Worker and browser. */
import { z } from "zod";

const unixMillisSchema = z.number().int().nonnegative().finite();
const durationMillisSchema = z.number().int().nonnegative().finite();
const transcriptEntityIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** Semantic role assigned to one diarized participant. */
export const transcriptParticipantRoleSchema = z.enum(["examiner", "student", "unknown"]);

/** How a diarized speaker was assigned a semantic examination role. */
export const transcriptRoleAssignmentSchema = z.enum(["first-speaker-heuristic", "unassigned"]);

/** A participant referenced by timed transcript turns. */
export const transcriptParticipantSchema = z.object({
  id: transcriptEntityIdSchema,
  role: transcriptParticipantRoleSchema,
  roleAssignment: transcriptRoleAssignmentSchema,
  displayName: z.string().trim().min(1),
  sourceSpeakerLabel: z.string().min(1),
});

/** One clickable, timed turn in the transcript. */
export const transcriptTurnSchema = z
  .object({
    id: transcriptEntityIdSchema,
    participantId: transcriptEntityIdSchema,
    startMs: durationMillisSchema,
    endMs: durationMillisSchema,
    text: z.string().trim().min(1),
    confidence: z.number().min(0).max(1).nullable(),
  })
  .refine((turn) => turn.endMs >= turn.startMs, {
    message: "Transcript turn end time must not precede its start time.",
    path: ["endMs"],
  });

/** The sole persisted transcript artifact format. */
export const transcriptSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: z.uuid(),
    source: z.object({
      objectKey: z.string().min(1),
      etag: z.string().min(1),
      durationMs: durationMillisSchema,
    }),
    transcription: z.object({
      provider: z.string().min(1),
      model: z.string().min(1),
      generatedAt: unixMillisSchema,
      languageCode: z.string().min(1).nullable(),
    }),
    participants: z.array(transcriptParticipantSchema),
    turns: z.array(transcriptTurnSchema),
  })
  .superRefine((transcript, context) => {
    const participantIds = new Set<string>();
    for (const [index, participant] of transcript.participants.entries()) {
      if (participantIds.has(participant.id)) {
        context.addIssue({
          code: "custom",
          message: "Transcript participant IDs must be unique.",
          path: ["participants", index, "id"],
        });
      }
      participantIds.add(participant.id);
    }

    const turnIds = new Set<string>();
    let previousStartMs = -1;
    for (const [index, turn] of transcript.turns.entries()) {
      if (turnIds.has(turn.id)) {
        context.addIssue({
          code: "custom",
          message: "Transcript turn IDs must be unique.",
          path: ["turns", index, "id"],
        });
      }
      turnIds.add(turn.id);
      if (!participantIds.has(turn.participantId)) {
        context.addIssue({
          code: "custom",
          message: "Transcript turns must reference a declared participant.",
          path: ["turns", index, "participantId"],
        });
      }
      if (turn.startMs < previousStartMs) {
        context.addIssue({
          code: "custom",
          message: "Transcript turns must be ordered by start time.",
          path: ["turns", index, "startMs"],
        });
      }
      if (turn.endMs > transcript.source.durationMs) {
        context.addIssue({
          code: "custom",
          message: "Transcript turns must fall within the recording duration.",
          path: ["turns", index, "endMs"],
        });
      }
      previousStartMs = turn.startMs;
    }
  });

export type TranscriptParticipantRole = z.infer<typeof transcriptParticipantRoleSchema>;
export type TranscriptRoleAssignment = z.infer<typeof transcriptRoleAssignmentSchema>;
export type TranscriptParticipant = z.infer<typeof transcriptParticipantSchema>;
export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;
