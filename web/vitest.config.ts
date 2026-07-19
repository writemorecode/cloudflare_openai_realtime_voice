import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["web/src/**/*.test.tsx"],
    setupFiles: ["./web/src/test-setup.ts"],
  },
});
