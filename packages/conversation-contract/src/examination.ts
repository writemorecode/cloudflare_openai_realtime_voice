/** Runtime-validated examination HTTP contracts shared by the Worker and browser. */
import { z } from "zod";

/** Validates identifiers represented as UUID strings. */
const uuidSchema = z.uuid();
/** Validates non-negative Unix timestamps measured in milliseconds. */
const unixMillisSchema = z.number().int().nonnegative().finite();

/** Validates a question belonging to an examination. */
export const examinationQuestionSchema = z.object({
  id: uuidSchema,
  ordinal: z.number().int().positive(),
  text: z.string().min(1).max(4000),
});

/** Validates the list-facing metadata for an examination. */
export const examinationSummarySchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(160),
  subject: z.string().min(1).max(160),
  questionCount: z.number().int().positive(),
  createdAt: unixMillisSchema,
});

/** Validates a complete examination, including all of its questions. */
export const examinationSchema = examinationSummarySchema.extend({
  questions: z.array(examinationQuestionSchema).min(1),
});

/** Validates the response returned when examinations are listed. */
export const examinationListSchema = z.object({
  examinations: z.array(examinationSummarySchema),
});

/** Validates the payload used to create an examination. */
export const createExaminationRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  subject: z.string().trim().min(1).max(160),
  questions: z.array(z.string().trim().min(1).max(4000)).min(1).max(100),
});

/** Validates whether an examination session still has a current question. */
export const examinationQuestionStateSchema = z.enum(["in_progress", "complete"]);

/** Validates an examination session and its current conversation state. */
export const examinationSessionSchema = z.object({
  id: uuidSchema,
  examinationId: uuidSchema,
  examinationName: z.string().min(1).max(160),
  subject: z.string().min(1).max(160),
  conversationId: uuidSchema,
  questionState: examinationQuestionStateSchema,
  currentQuestionOrdinal: z.number().int().positive(),
  questionCount: z.number().int().positive(),
  createdAt: unixMillisSchema,
  questionsCompletedAt: unixMillisSchema.nullable(),
  conversationState: z
    .enum(["created", "starting", "live", "ending", "completed", "cancelled", "failed"])
    .nullable(),
  recordingAvailable: z.boolean(),
});

/** Validates the response returned when examination sessions are listed. */
export const examinationSessionListSchema = z.object({
  sessions: z.array(examinationSessionSchema),
});

/** Validates the current question or completion result for an examination session. */
export const currentExaminationQuestionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("question"),
    examinationSessionId: uuidSchema,
    examinationName: z.string().min(1).max(160),
    subject: z.string().min(1).max(160),
    question: examinationQuestionSchema,
    questionCount: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("complete"),
    examinationSessionId: uuidSchema,
    examinationName: z.string().min(1).max(160),
    subject: z.string().min(1).max(160),
    questionCount: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
  }),
]);

/** Validates the outcome assigned when an examination question is completed. */
export const questionDispositionSchema = z.enum([
  "answered",
  "answered_after_follow_up",
  "unable_to_answer",
]);

/** Validates the payload used to complete the current examination question. */
export const completeExaminationQuestionRequestSchema = z.object({
  questionId: uuidSchema,
  expectedRevision: z.number().int().nonnegative(),
  disposition: questionDispositionSchema,
});

/** A question stored in an examination. */
export type ExaminationQuestion = z.infer<typeof examinationQuestionSchema>;
/** Summary data displayed for an examination. */
export type ExaminationSummary = z.infer<typeof examinationSummarySchema>;
/** An examination and its ordered questions. */
export type Examination = z.infer<typeof examinationSchema>;
/** The response body for an examination list request. */
export type ExaminationList = z.infer<typeof examinationListSchema>;
/** Input accepted when creating an examination. */
export type CreateExaminationRequest = z.infer<typeof createExaminationRequestSchema>;
/** A student's session for taking an examination. */
export type ExaminationSession = z.infer<typeof examinationSessionSchema>;
/** The response body for an examination-session list request. */
export type ExaminationSessionList = z.infer<typeof examinationSessionListSchema>;
/** The current examination question, or an indicator that the session is complete. */
export type CurrentExaminationQuestion = z.infer<typeof currentExaminationQuestionSchema>;
/** A classification of the student's response to an examination question. */
export type QuestionDisposition = z.infer<typeof questionDispositionSchema>;
/** Input accepted when completing the current examination question. */
export type CompleteExaminationQuestionRequest = z.infer<
  typeof completeExaminationQuestionRequestSchema
>;
