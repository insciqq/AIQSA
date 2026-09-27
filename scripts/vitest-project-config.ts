import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

export const vitestBaseExcludes = [
  "node_modules/**",
  ".next/**",
  "tests/e2e/**",
  "scripts/longmemeval-qualification.test.ts"
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

const vitestDomTests = [
  "app/**/*.test.{ts,tsx}",
  "components/**/*.test.{ts,tsx}",
  "features/**/*.test.{ts,tsx}",
  "lib/browser/**/*.test.{ts,tsx}"
];

export const vitestResolveConfig = {
  alias: {
    "@": fileURLToPath(new URL("..", import.meta.url))
  }
};

const vitestCommonTestConfig = {
  allowOnly: false,
  css: true,
  globals: true
} as const;

// Stateful tests retain their existing environment and setup.
export const vitestSharedTestConfig = {
  ...vitestCommonTestConfig,
  environment: "jsdom",
  maxWorkers: 2,
  setupFiles: "./vitest.setup.ts"
} as const;

export function resolveHermeticMaxWorkers(
  value = process.env.AIQSA_TEST_MAX_WORKERS,
  parallelism = availableParallelism()
): number {
  if (value === undefined) return Math.min(4, parallelism);
  const workers = Number(value);
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(workers)) {
    throw new Error("AIQSA_TEST_MAX_WORKERS must be a positive integer");
  }
  return workers;
}

const vitestHermeticTestConfig = {
  ...vitestCommonTestConfig,
  setupFiles: "./vitest.hermetic.setup.ts"
} as const;

export const vitestHermeticProjects = [
  {
    resolve: vitestResolveConfig,
    test: {
      ...vitestHermeticTestConfig,
      name: "hermetic-node",
      environment: "node",
      include: vitestHermeticTests,
      exclude: [...vitestBaseExcludes, ...vitestStatefulTests, ...vitestDomTests]
    }
  },
  {
    resolve: vitestResolveConfig,
    test: {
      ...vitestHermeticTestConfig,
      name: "hermetic-dom",
      environment: "jsdom",
      include: vitestDomTests,
      exclude: [...vitestBaseExcludes, ...vitestStatefulTests]
    }
  }
];
