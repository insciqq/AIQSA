import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";
import { databaseRequiredTestFiles } from "./vitest.hermetic.policy";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [
        "node_modules/**",
        ".next/**",
        "tests/e2e/**",
        "**/*.integration.test.{ts,tsx}",
        ...databaseRequiredTestFiles
      ]
    }
  })
);
