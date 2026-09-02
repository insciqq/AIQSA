import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "benchmarks/longmemeval/**/*.test.ts",
      "scripts/longmemeval-qualification.test.ts"
    ]
  }
});
