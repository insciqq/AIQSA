import { fileURLToPath } from "node:url";

export const vitestBaseExcludes = [
  "node_modules/**",
  ".next/**",
  "tests/e2e/**"
];

export const vitestStatefulTests = [
  "**/*.integration.test.{ts,tsx}",
  "**/*.prisma.test.{ts,tsx}"
];

export const vitestHermeticTests = [
  "app/**/*.test.{ts,tsx}",
  "components/**/*.test.{ts,tsx}",
  "features/**/*.test.{ts,tsx}",
  "lib/**/*.test.{ts,tsx}",
  "ops/**/*.test.{ts,tsx}",
  "prisma/**/*.test.{ts,tsx}",
  "scripts/**/*.test.{ts,tsx}"
];

export const vitestResolveConfig = {
  alias: {
    "@": fileURLToPath(new URL("..", import.meta.url))
  }
};

export const vitestSharedTestConfig = {
  allowOnly: false,
  css: true,
  environment: "jsdom",
  globals: true,
  setupFiles: "./vitest.setup.ts"
} as const;
