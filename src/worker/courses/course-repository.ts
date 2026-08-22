import type { CourseSummary, CreateCourseRequest } from "@ai-oral-exam/conversation-contract";

interface CourseRow {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  readonly description: string | null;
  readonly examination_count: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export async function insertCourse(
  database: D1Database,
  input: {
    readonly id: string;
    readonly userId: number;
    readonly request: CreateCourseRequest;
    readonly now: number;
  },
): Promise<CourseSummary> {
  const code = input.request.code ?? null;
  const description = input.request.description ?? null;
  await database
    .prepare(
      `INSERT INTO courses (id, created_by_user_id, name, code, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.id, input.userId, input.request.name, code, description, input.now, input.now)
    .run();
  return {
    id: input.id,
    name: input.request.name,
    code,
    description,
    examinationCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export async function listCourses(database: D1Database): Promise<CourseSummary[]> {
  const rows = await database
    .prepare(
      `SELECT c.id, c.name, c.code, c.description, c.created_at, c.updated_at,
            COUNT(e.id) AS examination_count
     FROM courses c LEFT JOIN examinations e ON e.course_id = c.id
     GROUP BY c.id ORDER BY c.created_at DESC, c.id ASC`,
    )
    .all<CourseRow>();
  return rows.results.map(toCourse);
}

export async function findCourse(database: D1Database, id: string): Promise<CourseSummary | null> {
  const row = await database
    .prepare(
      `SELECT c.id, c.name, c.code, c.description, c.created_at, c.updated_at,
            COUNT(e.id) AS examination_count
     FROM courses c LEFT JOIN examinations e ON e.course_id = c.id
     WHERE c.id = ? GROUP BY c.id`,
    )
    .bind(id)
    .first<CourseRow>();
  return row === null ? null : toCourse(row);
}

function toCourse(row: CourseRow): CourseSummary {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    examinationCount: row.examination_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
