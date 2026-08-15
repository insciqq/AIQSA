import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [
        "node_modules/**",
        ".next/**",
        "tests/e2e/**",
        "**/*.integration.test.{ts,tsx}",
        "**/*.prisma.test.{ts,tsx}"
      ]
    }
  })
);
