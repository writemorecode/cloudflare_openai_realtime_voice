import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const d1Migrations = await readD1Migrations("./migrations");
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
          TEST_D1_MIGRATIONS: d1Migrations,
          TEST_EXAM_D1_MIGRATIONS: examinationD1Migrations,
          AGENT_CALLBACK_TOKEN: "test-agent-callback-token",
          ALLOWED_ORIGIN: "http://localhost:5173/",
          CONVERSATION_ID_SECRET: "test-conversation-id-secret",
          LIVEKIT_API_KEY: "test-livekit-api-key",
          LIVEKIT_API_SECRET: "test-livekit-api-secret-with-sufficient-entropy",
          LIVEKIT_URL: "wss://test.livekit.cloud",
          R2_BUCKET_NAME: "test-recordings",
          R2_ENDPOINT: "https://test-account.r2.cloudflarestorage.com",
          R2_ACCESS_KEY_ID: "test-r2-access-key",
          R2_SECRET_ACCESS_KEY: "test-r2-secret-key",
        },
      },
    }),
  ],
});
