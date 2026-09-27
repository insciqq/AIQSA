import { defineConfig } from "vitest/config";
import {
  resolveHermeticMaxWorkers,
  vitestHermeticProjects
} from "./scripts/vitest-project-config";

export default defineConfig({
  test: {
    maxWorkers: resolveHermeticMaxWorkers(),
    projects: vitestHermeticProjects
  }
});
