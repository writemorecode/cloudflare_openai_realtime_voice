/** Runtime-validated examination HTTP contracts shared by the Worker and browser. */
import { z } from "zod";

const uuidSchema = z.uuid();
const unixMillisSchema = z.number().int().nonnegative().finite();

export const examinationQuestionSchema = z.object({
  id: uuidSchema,
  ordinal: z.number().int().positive(),
  text: z.string().min(1).max(4000),
});

export const examinationSummarySchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(160),
  subject: z.string().min(1).max(160),
  questionCount: z.number().int().positive(),
  createdAt: unixMillisSchema,
});

export const examinationSchema = examinationSummarySchema.extend({
  questions: z.array(examinationQuestionSchema).min(1),
});

export const examinationListSchema = z.object({
  examinations: z.array(examinationSummarySchema),
});

export const createExaminationRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  subject: z.string().trim().min(1).max(160),
  questions: z.array(z.string().trim().min(1).max(4000)).min(1).max(100),
});

export const examinationQuestionStateSchema = z.enum(["in_progress", "complete"]);

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

export const examinationSessionListSchema = z.object({
  sessions: z.array(examinationSessionSchema),
});

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

export const questionDispositionSchema = z.enum([
  "answered",
  "answered_after_follow_up",
  "unable_to_answer",
]);

export const completeExaminationQuestionRequestSchema = z.object({
  questionId: uuidSchema,
  expectedRevision: z.number().int().nonnegative(),
  disposition: questionDispositionSchema,
});

export type ExaminationQuestion = z.infer<typeof examinationQuestionSchema>;
export type ExaminationSummary = z.infer<typeof examinationSummarySchema>;
export type Examination = z.infer<typeof examinationSchema>;
export type ExaminationList = z.infer<typeof examinationListSchema>;
export type CreateExaminationRequest = z.infer<typeof createExaminationRequestSchema>;
export type ExaminationSession = z.infer<typeof examinationSessionSchema>;
export type ExaminationSessionList = z.infer<typeof examinationSessionListSchema>;
export type CurrentExaminationQuestion = z.infer<typeof currentExaminationQuestionSchema>;
export type QuestionDisposition = z.infer<typeof questionDispositionSchema>;
export type CompleteExaminationQuestionRequest = z.infer<
  typeof completeExaminationQuestionRequestSchema
>;
