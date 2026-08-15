import { defineConfig } from "vitest/config";
import {
  vitestBaseExcludes,
  vitestHermeticTests,
  vitestResolveConfig,
  vitestSharedTestConfig,
  vitestStatefulTests
} from "./scripts/vitest-project-config";

export default defineConfig({
  resolve: vitestResolveConfig,
  test: {
    ...vitestSharedTestConfig,
    exclude: [...vitestBaseExcludes, ...vitestStatefulTests],
    include: vitestHermeticTests
  }
});
