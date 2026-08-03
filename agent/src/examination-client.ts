/** Authenticated control-plane client used only by the separately deployed LiveKit agent. */
import { z } from "zod";
import { Result, TaggedError } from "better-result";

const questionSchema = z.object({
  id: z.uuid(),
  ordinal: z.number().int().positive(),
  text: z.string().min(1).max(4000),
});

const currentQuestionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("question"),
    examinationSessionId: z.uuid(),
    examinationName: z.string().min(1).max(160),
    subject: z.string().min(1).max(160),
    question: questionSchema,
    questionCount: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("complete"),
    examinationSessionId: z.uuid(),
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

export type CurrentExaminationQuestion = z.infer<typeof currentQuestionSchema>;
export type QuestionDisposition = z.infer<typeof questionDispositionSchema>;

export interface ExaminationQuestionClient {
  getCurrent(conversationId: string): Promise<CurrentExaminationQuestion>;
  completeCurrent(
    conversationId: string,
    input: {
      readonly questionId: string;
      readonly expectedRevision: number;
      readonly disposition: QuestionDisposition;
    },
  ): Promise<CurrentExaminationQuestion>;
}

const ExaminationClientErrorBase = TaggedError("ExaminationClientError");

export class ExaminationClientError extends ExaminationClientErrorBase<{
  readonly code: "request_failed" | "invalid_response";
  readonly cause: unknown;
  readonly message: string;
}> {
  constructor(code: "request_failed" | "invalid_response", cause?: unknown) {
    super({ code, message: code, cause });
  }
}

export class HttpExaminationQuestionClient implements ExaminationQuestionClient {
  constructor(
    private readonly controlPlaneUrl: string,
    private readonly callbackToken: string,
  ) {}

  getCurrent(conversationId: string): Promise<CurrentExaminationQuestion> {
    return this.request(
      `/v1/integrations/examinations/conversations/${conversationId}/current-question`,
    );
  }

  completeCurrent(
    conversationId: string,
    input: {
      readonly questionId: string;
      readonly expectedRevision: number;
      readonly disposition: QuestionDisposition;
    },
  ): Promise<CurrentExaminationQuestion> {
    return this.request(
      `/v1/integrations/examinations/conversations/${conversationId}/complete-question`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  private async request(path: string, init: RequestInit = {}): Promise<CurrentExaminationQuestion> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.callbackToken}`);
    const responseResult = await Result.tryPromise(() =>
      fetch(new URL(path, this.controlPlaneUrl), {
        ...init,
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
    );
    if (responseResult.isErr()) {
      throw new ExaminationClientError("request_failed", responseResult.error.cause);
    }
    const response = responseResult.value;
    if (!response.ok) throw new ExaminationClientError("request_failed");

    const bodyResult = await Result.tryPromise(() => response.json());
    if (bodyResult.isErr()) {
      throw new ExaminationClientError("invalid_response", bodyResult.error.cause);
    }
    const parsed = currentQuestionSchema.safeParse(bodyResult.value);
    if (!parsed.success) throw new ExaminationClientError("invalid_response");
    return parsed.data;
  }
}
