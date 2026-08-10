import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

const testEnv = env as Env & {
  TEST_EXAM_D1_MIGRATIONS: D1Migration[];
};

await applyD1Migrations(testEnv.EXAM_DB, testEnv.TEST_EXAM_D1_MIGRATIONS);
await testEnv.EXAM_DB.prepare(
  `INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)
   ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`,
)
  .bind(
    "examiner",
    "pbkdf2_sha256$100000$AAECAwQFBgcICQoLDA0ODw$SdScJfWXhGIJ8Nkud3CrZOHHXpS0zmxQkmXuZxddKh4",
    Date.now(),
  )
  .run();
