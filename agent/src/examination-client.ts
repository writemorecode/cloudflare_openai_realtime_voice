/** Authenticated control-plane client used only by the separately deployed LiveKit agent. */
import { z } from "zod";

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

export class ExaminationClientError extends Error {
  constructor(
    readonly code: "request_failed" | "invalid_response",
    cause?: unknown,
  ) {
    super(code, { cause });
    this.name = "ExaminationClientError";
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
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.callbackToken}`);
      response = await fetch(new URL(path, this.controlPlaneUrl), {
        ...init,
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (cause) {
      throw new ExaminationClientError("request_failed", cause);
    }
    if (!response.ok) throw new ExaminationClientError("request_failed");

    const body = await response.json().then(
      (value: unknown) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    if (!body.ok) throw new ExaminationClientError("invalid_response", body.cause);
    const parsed = currentQuestionSchema.safeParse(body.value);
    if (!parsed.success) throw new ExaminationClientError("invalid_response");
    return parsed.data;
  }
}
