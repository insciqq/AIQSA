import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MemoryCoordinatorError } from "../coordinator/errors";
import { MemoryDeletionContributorRegistry } from "./registry";

const targetClaim = {
  attemptCount: 1,
  claimToken: "claim-1",
  id: "deletion-1",
  leaseExpiresAt: new Date("2026-08-10T12:05:00.000Z"),
  memoryGeneration: 3,
  operation: "FORGET_PURGE" as const,
  recoveredLease: false,
  resumedFromBlocked: false,
  targetId: "fact-1",
  targetType: "MEMORY_FACT@memory-p2-purge-v1",
  userId: "user-1"
};

const tx = {} as Prisma.TransactionClient;

function registry() {
  return new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: [
      { id: "content", version: "v1" },
      { id: "evidence", version: "v1" }
    ]
  });
}

describe("Memory deletion contributor registry", () => {
  it("refuses a claim while a required versioned contributor is missing", async () => {
    const contributors = registry();
    contributors.register({
      audit: vi.fn(async () => 0),
      id: "content",
      purge: vi.fn(async () => undefined),
      version: "v1"
    });

    await expect(contributors.handler().execute(targetClaim, {
      now: () => new Date(),
      signal: new AbortController().signal
    })).rejects.toEqual(
      new MemoryCoordinatorError("memory_deletion_handler_unavailable", true)
    );
    expect(contributors.missingContributors()).toEqual(["evidence"]);
  });

  it("purges and audits every required leaf before returning a complete apply", async () => {
    const contributors = registry();
    const purged = new Set<string>();
    for (const id of ["content", "evidence"]) {
      contributors.register({
        audit: vi.fn(async () => purged.has(id) ? 0 : 1),
        id,
        purge: vi.fn(async () => {
          purged.add(id);
        }),
        version: "v1"
      });
    }

    const result = await contributors.handler().execute(targetClaim, {
      now: () => new Date(),
      signal: new AbortController().signal
    });
    await expect(result.apply?.(tx, targetClaim)).resolves.toBeUndefined();
    await expect(contributors.inspect(tx, {
      kind: "MEMORY_FACT",
      manifestVersion: "memory-p2-purge-v1",
      operation: "FORGET_PURGE",
      targetId: "fact-1",
      targetType: "MEMORY_FACT@memory-p2-purge-v1",
      userId: "user-1"
    })).resolves.toEqual({
      complete: true,
      completedUnits: 2,
      missingContributors: [],
      totalUnits: 2
    });
  });

  it("fails apply when a registered leaf still audits residual data", async () => {
    const contributors = new MemoryDeletionContributorRegistry({
      operation: "FORGET_PURGE",
      requirements: [{ id: "content", version: "v1" }]
    });
    contributors.register({
      audit: vi.fn(async () => 1),
      id: "content",
      purge: vi.fn(async () => undefined),
      version: "v1"
    });
    const result = await contributors.handler().execute(targetClaim, {
      now: () => new Date(),
      signal: new AbortController().signal
    });

    await expect(result.apply?.(tx, targetClaim)).rejects.toEqual(
      new MemoryCoordinatorError("memory_purge_incomplete", true)
    );
    expect(() => contributors.register({
      audit: async () => 0,
      id: "content",
      purge: async () => undefined,
      version: "v2"
    })).toThrow("memory_deletion_contributor_version_unexpected");
  });
});
