import { defineConfig } from "vitest/config";
import { vitestResolveConfig } from "../../scripts/vitest-project-config";

export default defineConfig({
  resolve: vitestResolveConfig,
  test: {
    environment: "node",
    include: ["benchmarks/aiqsa-memory-live-microbench/**/*.test.ts"]
  }
});
