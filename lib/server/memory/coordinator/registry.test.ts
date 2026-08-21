import { describe, expect, it, vi } from "vitest";
import {
  memoryCoordinatorJobMaxAttempts,
  MEMORY_COORDINATOR_JOB_KINDS,
  MEMORY_COORDINATOR_ORPHANED_JOB_KINDS,
  MemoryCoordinatorRegistry
} from "./registry";

function handler(kind: (typeof MEMORY_COORDINATOR_JOB_KINDS)[number]) {
  return {
    execute: vi.fn(),
    kind,
    preflight: vi.fn(async () => ({ status: "READY" as const }))
  };
}

describe("Memory coordinator registry", () => {
  it("caps active provider-learning stages at two total attempts", () => {
    expect(memoryCoordinatorJobMaxAttempts("EXTRACT_FACTS", 3)).toBe(2);
    expect(memoryCoordinatorJobMaxAttempts("CONSOLIDATE_CANDIDATE", 3)).toBe(2);
    expect(memoryCoordinatorJobMaxAttempts("EMBED_ITEMS", 3)).toBe(3);
  });

  it("requires every manifest kind and reports incomplete registration", () => {
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob(handler("INDEX_HISTORY"));

    expect(registry.checkCompleteness()).toEqual({
      extra: [],
      missing: expect.arrayContaining([
        "EXTRACT_FACTS",
        "CONSOLIDATE_CANDIDATE",
        "EMBED_ITEMS",
        "REBUILD_INDEX"
      ]),
      ok: false
    });
    expect(() => registry.assertComplete()).toThrow(
      "memory_job_registry_incomplete"
    );
  });

  it("accepts a complete manifest and rejects retired kinds", () => {
    const registry = new MemoryCoordinatorRegistry();
    const unregister = MEMORY_COORDINATOR_JOB_KINDS.map((kind) =>
      registry.registerJob(handler(kind))
    );

    expect(registry.checkCompleteness()).toEqual({
      extra: [],
      missing: [],
      ok: true
    });
    expect(() => registry.registerJob({
      execute: vi.fn(),
      kind: "RECONCILE_BRANCH",
      preflight: vi.fn(async () => ({ status: "READY" as const }))
    })).toThrow("memory_job_kind_undeclared");
    expect(() => registry.registerJob({
      execute: vi.fn(),
      kind: "VERIFY_CANDIDATE",
      preflight: vi.fn(async () => ({ status: "READY" as const }))
    })).toThrow("memory_job_kind_undeclared");
    expect(registry.unsupportedJobKinds()).toEqual(
      expect.arrayContaining([...MEMORY_COORDINATOR_ORPHANED_JOB_KINDS])
    );

    unregister.forEach((remove) => remove());
    expect(registry.jobKinds()).toEqual([]);
  });
});
