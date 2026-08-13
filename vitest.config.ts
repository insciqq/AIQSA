import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url))
    }
  },
  test: {
    allowOnly: false,
    css: true,
    environment: "jsdom",
    exclude: ["node_modules/**", ".next/**", "tests/e2e/**"],
    globals: true,
    include: [
      "app/**/*.test.{ts,tsx}",
      "components/**/*.test.{ts,tsx}",
      "features/**/*.test.{ts,tsx}",
      "lib/**/*.test.{ts,tsx}",
      "tests/harness/**/*.test.ts"
    ],
    // Avoid oversubscribing the subprocess-heavy harness and ESLint fixtures on
    // high-core hosts while preserving Vitest's strict per-test timeout.
    maxWorkers: "33%",
    setupFiles: "./vitest.setup.ts"
  }
});
