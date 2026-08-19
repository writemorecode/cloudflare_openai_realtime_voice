/** D1 persistence for immutable examinations and their examination sessions. */
import {
  type CreateExaminationRequest,
  type CurrentExaminationQuestion,
  type Examination,
  type ExaminationSession,
  type ExaminationSummary,
  type QuestionDisposition,
} from "@ai-oral-exam/conversation-contract";
import { Result } from "better-result";

interface ExaminationRow {
  readonly id: string;
  readonly name: string;
  readonly subject: string;
  readonly question_count: number;
  readonly created_at: number;
}

interface QuestionRow {
  readonly id: string;
  readonly ordinal: number;
  readonly text: string;
}

interface SessionRow {
  readonly id: string;
  readonly examination_id: string;
  readonly user_id: number;
  readonly examination_name: string;
  readonly subject: string;
  readonly conversation_id: string;
  readonly question_state: "in_progress" | "complete";
  readonly current_question_ordinal: number;
  readonly question_count: number;
  readonly created_at: number;
  readonly questions_completed_at: number | null;
}

interface CurrentQuestionRow extends SessionRow {
  readonly question_id: string | null;
  readonly question_text: string | null;
  readonly question_revision: number;
}

interface CompletionRow {
  readonly question_id: string;
}

export interface ExaminationRepositoryError {
  readonly code: "missing_question_id" | "missing_current_question" | "database_operation_failed";
  readonly message: string;
  readonly cause?: unknown;
}

const CURRENT_QUESTION_SQL = `SELECT s.id, s.examination_id, e.name AS examination_name, e.subject,
                                    s.user_id, s.conversation_id, s.question_state,
                                    s.current_question_ordinal, s.question_revision, s.created_at,
                                    s.questions_completed_at,
                                    COUNT(all_questions.id) AS question_count,
                                    current_question.id AS question_id,
                                    current_question.text AS question_text
                             FROM examination_sessions s
                             JOIN examinations e ON e.id = s.examination_id
                             JOIN examination_questions all_questions
                               ON all_questions.examination_id = e.id
                             LEFT JOIN examination_questions current_question
                               ON current_question.examination_id = e.id
                              AND current_question.ordinal = s.current_question_ordinal
                             WHERE s.conversation_id = ?
                             GROUP BY s.id`;

export interface StoredExaminationSession {
  readonly id: string;
  readonly examinationId: string;
  readonly userId: number;
  readonly examinationName: string;
  readonly subject: string;
  readonly conversationId: string;
  readonly questionState: "in_progress" | "complete";
  readonly currentQuestionOrdinal: number;
  readonly questionCount: number;
  readonly createdAt: number;
  readonly questionsCompletedAt: number | null;
}

export interface CreateExaminationInput {
  readonly id: string;
  readonly userId: number;
  readonly request: CreateExaminationRequest;
  readonly questionIds: readonly string[];
  readonly createdAt: number;
}

export async function insertExamination(
  database: D1Database,
  input: CreateExaminationInput,
): Promise<Result<Examination, ExaminationRepositoryError>> {
  const questions: Array<{ readonly id: string; readonly ordinal: number; readonly text: string }> =
    [];
  for (const [index, text] of input.request.questions.entries()) {
    const id = input.questionIds[index];
    if (id === undefined) {
      return Result.err({
        code: "missing_question_id",
        message: "A question identifier is missing.",
      });
    }
    questions.push({ id, ordinal: index + 1, text });
  }
  const statements = [
    database
      .prepare(
        `INSERT INTO examinations (id, created_by_user_id, name, subject, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(input.id, input.userId, input.request.name, input.request.subject, input.createdAt),
    ...questions.map((question) =>
      database
        .prepare(
          `INSERT INTO examination_questions (id, examination_id, ordinal, text)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(question.id, input.id, question.ordinal, question.text),
    ),
  ];
  await database.batch(statements);
  return Result.ok({
    id: input.id,
    name: input.request.name,
    subject: input.request.subject,
    questionCount: input.request.questions.length,
    createdAt: input.createdAt,
    questions,
  });
}

export async function listExaminations(database: D1Database): Promise<ExaminationSummary[]> {
  const rows = await database
    .prepare(
      `SELECT e.id, e.name, e.subject, e.created_at, COUNT(q.id) AS question_count
       FROM examinations e
       JOIN examination_questions q ON q.examination_id = e.id
       GROUP BY e.id
       ORDER BY e.created_at DESC, e.id ASC`,
    )
    .all<ExaminationRow>();
  return rows.results.map(examinationSummary);
}

export async function findExamination(
  database: D1Database,
  examinationId: string,
): Promise<Examination | null> {
  const row = await database
    .prepare(
      `SELECT e.id, e.name, e.subject, e.created_at, COUNT(q.id) AS question_count
       FROM examinations e
       JOIN examination_questions q ON q.examination_id = e.id
       WHERE e.id = ?
       GROUP BY e.id`,
    )
    .bind(examinationId)
    .first<ExaminationRow>();
  if (row === null) return null;
  const questions = await database
    .prepare(
      `SELECT id, ordinal, text
       FROM examination_questions
       WHERE examination_id = ?
       ORDER BY ordinal ASC`,
    )
    .bind(examinationId)
    .all<QuestionRow>();
  return {
    ...examinationSummary(row),
    questions: questions.results,
  };
}

export async function insertExaminationSession(
  database: D1Database,
  input: {
    readonly id: string;
    readonly examinationId: string;
    readonly userId: number;
    readonly conversationId: string;
    readonly createdAt: number;
  },
): Promise<StoredExaminationSession | null> {
  await database
    .prepare(
      `INSERT INTO examination_sessions (
         id, examination_id, user_id, conversation_id, question_state,
         current_question_ordinal, question_revision, created_at
       )
       VALUES (?, ?, ?, ?, 'in_progress', 1, 0, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(input.id, input.examinationId, input.userId, input.conversationId, input.createdAt)
    .run();
  return findExaminationSessionById(database, input.id);
}

export async function findExaminationSessionById(
  database: D1Database,
  sessionId: string,
): Promise<StoredExaminationSession | null> {
  return sessionBy(database, "s.id", sessionId);
}

export async function listExaminationSessions(
  database: D1Database,
  userId: number,
): Promise<StoredExaminationSession[]> {
  const rows = await database
    .prepare(sessionSelect("s.user_id = ?", "ORDER BY s.created_at DESC, s.id ASC"))
    .bind(userId)
    .all<SessionRow>();
  return rows.results.map(storedSession);
}

export async function getCurrentExaminationQuestion(
  database: D1Database,
  conversationId: string,
): Promise<Result<CurrentExaminationQuestion | null, ExaminationRepositoryError>> {
  const row = await database
    .prepare(CURRENT_QUESTION_SQL)
    .bind(conversationId)
    .first<CurrentQuestionRow>();
  if (row === null) return Result.ok(null);
  return currentQuestion(row);
}

type CompletedExaminationQuestion =
  | { readonly status: "advanced"; readonly current: CurrentExaminationQuestion }
  | { readonly status: "already_applied"; readonly current: CurrentExaminationQuestion }
  | { readonly status: "not_found" }
  | { readonly status: "conflict" };

export async function completeExaminationQuestion(
  database: D1Database,
  input: {
    readonly conversationId: string;
    readonly questionId: string;
    readonly expectedRevision: number;
    readonly disposition: QuestionDisposition;
    readonly completedAt: number;
  },
): Promise<Result<CompletedExaminationQuestion, ExaminationRepositoryError>> {
  const row = await database
    .prepare(CURRENT_QUESTION_SQL)
    .bind(input.conversationId)
    .first<CurrentQuestionRow>();
  if (row === null) return Result.ok({ status: "not_found" });

  const previous = await database
    .prepare(
      `SELECT question_id
       FROM examination_question_completions
       WHERE session_id = ? AND question_id = ?`,
    )
    .bind(row.id, input.questionId)
    .first<CompletionRow>();
  if (previous !== null) {
    const current = currentQuestion(row);
    return current.isOk()
      ? Result.ok({ status: "already_applied", current: current.value })
      : current;
  }
  if (
    row.question_state !== "in_progress" ||
    row.question_id !== input.questionId ||
    row.question_revision !== input.expectedRevision
  ) {
    return Result.ok({ status: "conflict" });
  }

  const finalQuestion = row.current_question_ordinal >= row.question_count;
  const batchResult = await Result.tryPromise({
    try: () =>
      database.batch([
        database
          .prepare(
            `UPDATE examination_sessions
           SET question_state = ?,
               current_question_ordinal = ?,
               question_revision = question_revision + 1,
               questions_completed_at = ?
           WHERE id = ? AND question_state = 'in_progress'
             AND current_question_ordinal = ? AND question_revision = ?`,
          )
          .bind(
            finalQuestion ? "complete" : "in_progress",
            finalQuestion ? row.current_question_ordinal : row.current_question_ordinal + 1,
            finalQuestion ? input.completedAt : null,
            row.id,
            row.current_question_ordinal,
            row.question_revision,
          ),
        database
          .prepare(
            `INSERT INTO examination_question_completions (
             session_id, question_id, disposition, completed_at
           )
           VALUES (?, ?, ?, ?)`,
          )
          .bind(row.id, input.questionId, input.disposition, input.completedAt),
      ]),
    catch: (cause) => cause,
  });
  if (batchResult.isErr()) {
    const repeated = await database
      .prepare(
        `SELECT question_id
         FROM examination_question_completions
         WHERE session_id = ? AND question_id = ?`,
      )
      .bind(row.id, input.questionId)
      .first<CompletionRow>();
    if (repeated === null) {
      return Result.err({
        code: "database_operation_failed",
        message: "Unable to complete the examination question.",
        cause: batchResult.error,
      });
    }
    const latest = await database
      .prepare(CURRENT_QUESTION_SQL)
      .bind(input.conversationId)
      .first<CurrentQuestionRow>();
    if (latest === null) return Result.ok({ status: "not_found" });
    const current = currentQuestion(latest);
    return current.isOk()
      ? Result.ok({ status: "already_applied", current: current.value })
      : current;
  }

  const latest = await database
    .prepare(CURRENT_QUESTION_SQL)
    .bind(input.conversationId)
    .first<CurrentQuestionRow>();
  if (latest === null) return Result.ok({ status: "not_found" });
  const current = currentQuestion(latest);
  return current.isOk() ? Result.ok({ status: "advanced", current: current.value }) : current;
}

export type TranscriptionStatus = "queued" | "running" | "complete" | "failed";

export async function findLatestTranscriptionStatus(
  database: D1Database,
  examinationSessionId: string,
): Promise<TranscriptionStatus | null> {
  const row = await database
    .prepare(
      `SELECT status FROM transcription_jobs
       WHERE examination_session_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(examinationSessionId)
    .first<{ status: TranscriptionStatus }>();
  return row?.status ?? null;
}

export function publicExaminationSession(
  session: StoredExaminationSession,
  state: ExaminationSession["conversationState"],
  recordingAvailable: boolean,
  transcriptionStatus: TranscriptionStatus | null,
): ExaminationSession {
  return {
    id: session.id,
    examinationId: session.examinationId,
    examinationName: session.examinationName,
    subject: session.subject,
    conversationId: session.conversationId,
    questionState: session.questionState,
    currentQuestionOrdinal: session.currentQuestionOrdinal,
    questionCount: session.questionCount,
    createdAt: session.createdAt,
    questionsCompletedAt: session.questionsCompletedAt,
    conversationState: state,
    recordingAvailable,
    transcriptionStatus,
  };
}

async function sessionBy(
  database: D1Database,
  column: "s.id",
  value: string,
): Promise<StoredExaminationSession | null> {
  const row = await database
    .prepare(sessionSelect(`${column} = ?`))
    .bind(value)
    .first<SessionRow>();
  return row === null ? null : storedSession(row);
}

function sessionSelect(where: string, suffix = ""): string {
  return `SELECT s.id, s.examination_id, e.name AS examination_name, e.subject,
                 s.user_id, s.conversation_id, s.question_state, s.current_question_ordinal,
                 s.created_at, s.questions_completed_at, COUNT(q.id) AS question_count
          FROM examination_sessions s
          JOIN examinations e ON e.id = s.examination_id
          JOIN examination_questions q ON q.examination_id = e.id
          WHERE ${where}
          GROUP BY s.id
          ${suffix}`;
}

function examinationSummary(row: ExaminationRow): ExaminationSummary {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    questionCount: row.question_count,
    createdAt: row.created_at,
  };
}

function storedSession(row: SessionRow): StoredExaminationSession {
  return {
    id: row.id,
    examinationId: row.examination_id,
    userId: row.user_id,
    examinationName: row.examination_name,
    subject: row.subject,
    conversationId: row.conversation_id,
    questionState: row.question_state,
    currentQuestionOrdinal: row.current_question_ordinal,
    questionCount: row.question_count,
    createdAt: row.created_at,
    questionsCompletedAt: row.questions_completed_at,
  };
}

function currentQuestion(
  row: CurrentQuestionRow,
): Result<CurrentExaminationQuestion, ExaminationRepositoryError> {
  const base = {
    examinationSessionId: row.id,
    examinationName: row.examination_name,
    subject: row.subject,
    questionCount: row.question_count,
    revision: row.question_revision,
  };
  if (row.question_state === "complete") {
    return Result.ok({ status: "complete", ...base });
  }
  if (row.question_id === null || row.question_text === null) {
    return Result.err({
      code: "missing_current_question",
      message: "The current examination question is missing.",
    });
  }
  return Result.ok({
    status: "question",
    ...base,
    question: {
      id: row.question_id,
      ordinal: row.current_question_ordinal,
      text: row.question_text,
    },
  });
}
