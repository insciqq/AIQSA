import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVitest } from "vitest/node";
import {
  resolveHermeticMaxWorkers,
  vitestBaseExcludes,
  vitestHermeticProjects,
  vitestHermeticTests,
  vitestStatefulTests
} from "./vitest-project-config";

const root = fileURLToPath(new URL("..", import.meta.url));

afterEach(() => vi.unstubAllEnvs());

describe("hermetic worker budget", () => {
  it("defaults to four workers, bounded by available parallelism", () => {
    vi.stubEnv("AIQSA_TEST_MAX_WORKERS", undefined);
    expect(resolveHermeticMaxWorkers(undefined, 12)).toBe(4);
    expect(resolveHermeticMaxWorkers(undefined, 2)).toBe(2);
    expect(resolveHermeticMaxWorkers(undefined, 1)).toBe(1);
  });

  it("accepts an explicit budget without limiting it to this machine", () => {
    expect(resolveHermeticMaxWorkers("6", 2)).toBe(6);
    expect(resolveHermeticMaxWorkers("32", 2)).toBe(32);
  });

  it.each(["", "0", "-1", "1.5", "50%", "Infinity", "NaN", " 4", "9007199254740992"])(
    "rejects an invalid budget %j",
    (value) => {
      expect(() => resolveHermeticMaxWorkers(value)).toThrow(
        "AIQSA_TEST_MAX_WORKERS must be a positive integer"
      );
    }
  );

  it("lets the native CLI worker option override the environment budget", async () => {
    vi.stubEnv("AIQSA_TEST_MAX_WORKERS", "6");
    const runner = await createVitest("test", {
      root,
      config: "vitest.config.ts",
      watch: false,
      maxWorkers: 3
    }, { logLevel: "silent" });
    try {
      expect(runner.config.maxWorkers).toBe(3);
      expect(runner.projects).toHaveLength(2);
      for (const project of runner.projects) {
        expect(project.config.maxWorkers).toBeUndefined();
      }
    } finally {
      await runner.close();
    }
  });
});

describe("hermetic environment partition", () => {
  it("discovers every existing hermetic file exactly once with the original exclusions", async () => {
    const runner = await createVitest("test", {
      root,
      config: false,
      watch: false,
      maxWorkers: 1
    }, {
      logLevel: "silent",
      test: {
        projects: [
          {
            test: {
              name: "original-inventory",
              include: vitestHermeticTests,
              exclude: [...vitestBaseExcludes, ...vitestStatefulTests]
            }
          },
          ...vitestHermeticProjects
        ]
      }
    });
    try {
      const specifications = await runner.globTestSpecifications();
      const original = specifications
        .filter((specification) => specification.project.name === "original-inventory")
        .map((specification) => specification.moduleId);
      const partitioned = specifications
        .filter((specification) => specification.project.name !== "original-inventory")
        .map((specification) => specification.moduleId);
      expect(original.length).toBeGreaterThan(0);
      expect(partitioned.sort()).toEqual(original.sort());
      expect(new Set(partitioned).size).toBe(partitioned.length);

      const nodeProject = runner.projects.find((project) => project.name === "hermetic-node")!;
      const domProject = runner.projects.find((project) => project.name === "hermetic-dom")!;
      expect(nodeProject.config.environment).toBe("node");
      expect(domProject.config.environment).toBe("jsdom");
      for (const file of ["lib/server/example.test.ts", "lib/domain/example.test.ts", "scripts/example.test.ts"]) {
        expect(nodeProject.matchesTestGlob(`${root}${file}`)).toBe(true);
        expect(domProject.matchesTestGlob(`${root}${file}`)).toBe(false);
      }
      for (const file of ["components/example.test.tsx", "features/example.test.tsx", "lib/browser/example.test.ts"]) {
        expect(nodeProject.matchesTestGlob(`${root}${file}`)).toBe(false);
        expect(domProject.matchesTestGlob(`${root}${file}`)).toBe(true);
      }
      for (const file of [
        "lib/server/example.prisma.test.ts",
        "components/example.integration.test.tsx",
        "scripts/longmemeval-qualification.test.ts",
        "tests/e2e/example.test.ts",
        "benchmarks/knowledge/example.test.ts"
      ]) {
        expect(nodeProject.matchesTestGlob(`${root}${file}`)).toBe(false);
        expect(domProject.matchesTestGlob(`${root}${file}`)).toBe(false);
      }
    } finally {
      await runner.close();
    }
  });

  it("preserves the stateful environment, setup and serial execution in the full runner", async () => {
    vi.stubEnv("AIQSA_STATEFUL_TEST_TARGET", "DISPOSABLE");
    vi.stubEnv("AIQSA_TEST_MODE", "1");
    vi.stubEnv("DATABASE_URL", "postgresql://aiqsa:synthetic@postgres:5432/aiqsa?schema=public");
    vi.stubEnv("NODE_ENV", "development");
    const runner = await createVitest("test", {
      root,
      config: "vitest.full.config.ts",
      watch: false,
      maxWorkers: 6
    }, { logLevel: "silent" });
    try {
      expect(runner.config.maxWorkers).toBe(6);
      const stateful = runner.projects.find((project) => project.name === "stateful")!;
      expect(stateful.config.environment).toBe("jsdom");
      expect(stateful.config.setupFiles).toEqual([`${root}vitest.setup.ts`]);
      expect(stateful.config.maxWorkers).toBe(1);
      expect(stateful.config).toHaveProperty("fileParallelism", false);
      expect(stateful.config.include).toEqual(vitestStatefulTests);
      expect(stateful.config.exclude).toEqual(vitestBaseExcludes);
      expect(runner.projects.map((project) => project.name)).toEqual([
        "hermetic-node", "hermetic-dom", "stateful"
      ]);
    } finally {
      await runner.close();
    }
  });
});
