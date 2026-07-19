import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["smoke/**/*.smoke.test.ts"],
    testTimeout: 60_000,
  },
});
