/** Configures the opt-in agent smoke-test suite and its integration-test timeout. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["smoke/**/*.smoke.test.ts"],
    testTimeout: 60_000,
  },
});
