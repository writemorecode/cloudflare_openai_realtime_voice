import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const examinationD1Migrations = await readD1Migrations("./migrations-examinations");

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_EXAM_D1_MIGRATIONS: examinationD1Migrations,
          OPENAI_API_KEY: "test-openai-api-key",
          ALLOWED_ORIGIN: "http://localhost:5173/",
          CONVERSATION_ID_SECRET: "test-conversation-id-secret",
          AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
          AI_GATEWAY_ID: "test-transcription-gateway",
          AI_GATEWAY_TOKEN: "test-ai-gateway-token",
          R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
          R2_BUCKET_NAME: "oral-exam-recordings-dev",
          R2_ACCESS_KEY_ID: "test-r2-access-key-id",
          R2_SECRET_ACCESS_KEY: "test-r2-secret-access-key",
        },
      },
    }),
  ],
});
