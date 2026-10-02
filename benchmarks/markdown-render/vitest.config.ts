import { defineConfig } from "vitest/config";
import { vitestResolveConfig } from "../../scripts/vitest-project-config";

export default defineConfig({
  // Production JSX runtime, matching the production React build selected below.
  oxc: { jsx: { development: false, runtime: "automatic" } },
  resolve: vitestResolveConfig,
  test: {
    environment: "node",
    // Measure the React build users run, not the development build with its extra checks.
    env: { NODE_ENV: "production" },
    include: ["benchmarks/markdown-render/**/*.test.tsx"],
    // One worker keeps timings free of sibling test files.
    maxWorkers: 1,
    testTimeout: 120_000
  }
});
