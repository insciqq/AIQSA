import { defineConfig } from "vitest/config";
import { assertDisposableStatefulTestTarget } from "./scripts/stateful-test-target";
import {
  vitestBaseExcludes,
  vitestResolveConfig,
  vitestSharedTestConfig,
  vitestStatefulTests
} from "./scripts/vitest-project-config";

assertDisposableStatefulTestTarget(process.env);

export default defineConfig({
  test: {
    projects: [
      {
        extends: "./vitest.config.ts",
        test: {
          name: "hermetic"
        }
      },
      {
        resolve: vitestResolveConfig,
        test: {
          ...vitestSharedTestConfig,
          exclude: vitestBaseExcludes,
          fileParallelism: false,
          include: vitestStatefulTests,
          maxWorkers: 1,
          name: "stateful"
        }
      }
    ]
  }
});
