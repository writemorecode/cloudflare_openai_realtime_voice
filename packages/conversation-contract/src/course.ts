/** Runtime-validated course HTTP contracts shared by the Worker and browser. */
import { z } from "zod";

const uuidSchema = z.uuid();
const unixMillisSchema = z.number().int().nonnegative().finite();

export const courseSummarySchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(160),
  code: z.string().min(1).max(40).nullable(),
  description: z.string().max(4000).nullable(),
  learningGoals: z.string().max(4000).nullable(),
  examinationCount: z.number().int().nonnegative(),
  createdAt: unixMillisSchema,
  updatedAt: unixMillisSchema,
});

export const courseListSchema = z.object({ courses: z.array(courseSummarySchema) });

export const createCourseRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().min(1).max(40).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  learningGoals: z.string().trim().max(4000).nullable().optional(),
});

export type CourseSummary = z.infer<typeof courseSummarySchema>;
export type CourseList = z.infer<typeof courseListSchema>;
export type CreateCourseRequest = z.infer<typeof createCourseRequestSchema>;
