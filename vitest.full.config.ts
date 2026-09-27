import { defineConfig } from "vitest/config";
import { assertDisposableStatefulTestTarget } from "./scripts/stateful-test-target";
import {
  resolveHermeticMaxWorkers,
  vitestBaseExcludes,
  vitestHermeticProjects,
  vitestResolveConfig,
  vitestSharedTestConfig,
  vitestStatefulTests
} from "./scripts/vitest-project-config";

assertDisposableStatefulTestTarget(process.env);

export default defineConfig({
  test: {
    maxWorkers: resolveHermeticMaxWorkers(),
    projects: [
      ...vitestHermeticProjects,
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
