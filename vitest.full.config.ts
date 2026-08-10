import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { databaseRequiredTestFiles } from "./vitest.hermetic.policy";

const defaultExcludes = ["node_modules/**", ".next/**", "tests/e2e/**"];
const statefulTestFiles = [
  "**/*.integration.test.{ts,tsx}",
  ...databaseRequiredTestFiles
];

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
    exclude: defaultExcludes,
    globals: true,
    include: [
      "app/**/*.test.{ts,tsx}",
      "components/**/*.test.{ts,tsx}",
      "lib/**/*.test.{ts,tsx}",
      "tests/harness/**/*.test.ts"
    ],
    maxWorkers: "33%",
    setupFiles: "./vitest.setup.ts",
    projects: [
      {
        extends: true,
        test: {
          exclude: [...defaultExcludes, ...statefulTestFiles],
          name: "parallel"
        }
      },
      {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL(".", import.meta.url))
          }
        },
        test: {
          allowOnly: false,
          css: true,
          environment: "jsdom",
          exclude: defaultExcludes,
          fileParallelism: false,
          globals: true,
          include: statefulTestFiles,
          name: "stateful",
          setupFiles: "./vitest.setup.ts"
        }
      }
    ]
  }
});
