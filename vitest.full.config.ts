import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const defaultExcludes = ["node_modules/**", ".next/**", "tests/e2e/**"];
const statefulTestFiles = [
  "**/*.integration.test.{ts,tsx}",
  "**/*.prisma.test.{ts,tsx}"
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
      "features/**/*.test.{ts,tsx}",
      "lib/**/*.test.{ts,tsx}",
      "ops/**/*.test.{ts,tsx}",
      "prisma/**/*.test.{ts,tsx}",
      "scripts/**/*.test.{ts,tsx}"
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
