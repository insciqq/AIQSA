// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type ComposeFile = { services: Record<string, Record<string, unknown>> };

const production = parse(readFileSync(path.resolve("compose.yaml"), "utf8")) as ComposeFile;

describe("production PostgreSQL resource defaults", () => {
  const postgres = production.services.postgres!;

  it("keeps the CPU limit operator-overridable with a default of at least two CPUs", () => {
    const match = /^\$\{AIQSA_POSTGRES_CPU_LIMIT:-(\d+(?:\.\d+)?)\}$/u.exec(String(postgres.cpus));
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(2);
  });

  it("keeps the operator-overridable 1g memory default", () => {
    expect(postgres.mem_limit).toBe("${AIQSA_POSTGRES_MEMORY_LIMIT:-1g}");
  });
});
