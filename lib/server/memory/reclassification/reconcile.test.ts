import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_RECLASSIFICATION_TERMINAL_REVIVAL_BACKOFF_MS,
  reconcileMemoryFactReclassificationJobs
} from "./reconcile";

describe("memory reclassification discovery", () => {
  it("creates one global owner job per pending owner", async () => {
    const createMany = vi.fn(async () => ({ count: 1 }));
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const client = {
      $queryRaw: vi.fn(async () => [{
        memoryGeneration: 2,
        memoryRevision: 9,
        oldestVersionId: "version-1",
        pendingCount: 3,
        userId: "user-1"
      }]),
      memoryJob: { createMany, updateMany }
    } as never;
    await expect(reconcileMemoryFactReclassificationJobs(client)).resolves.toBe(1);
    expect(createMany).toHaveBeenCalledOnce();
    const calls = (createMany as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls;
    const input = calls[0]?.[0] as {
      data: readonly Record<string, unknown>[];
      skipDuplicates: boolean;
    } | undefined;
    expect(input).toBeDefined();
    if (!input) return;
    expect(input.data[0]).toMatchObject({
      idempotencyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      kind: "RECLASSIFY_FACTS",
      memoryGenerationSnapshot: 2,
      memoryRevisionSnapshot: 9,
      userId: "user-1"
    });
    expect(input.skipDuplicates).toBe(true);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([expect.objectContaining({
          OR: expect.arrayContaining([expect.objectContaining({
            state: { in: ["CANCELLED", "STALE"] }
          })])
        })]),
        kind: "RECLASSIFY_FACTS"
      })
    }));
  });

  it("revives a safely terminal current-epoch job", async () => {
    const createMany = vi.fn(async () => ({ count: 0 }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const client = {
      $queryRaw: vi.fn(async () => [{
        memoryGeneration: 4,
        memoryRevision: 12,
        oldestVersionId: "version-1",
        pendingCount: 1,
        userId: "user-1"
      }]),
      memoryJob: { createMany, updateMany }
    } as never;

    const now = new Date("2026-08-21T12:00:00.000Z");
    await expect(reconcileMemoryFactReclassificationJobs(client, now)).resolves.toBe(1);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        acceptedResultHash: null,
        attemptCount: 0,
        completedAt: null,
        state: "QUEUED"
      }),
      where: expect.objectContaining({
        AND: expect.arrayContaining([expect.objectContaining({
          OR: expect.arrayContaining([expect.objectContaining({
            errorCode: "memory_reclassification_provider_unavailable",
            state: "TERMINAL_FAILED",
            updatedAt: {
              lte: new Date(
                now.getTime() -
                  MEMORY_RECLASSIFICATION_TERMINAL_REVIVAL_BACKOFF_MS
              )
            }
          })])
        })])
      })
    }));
  });

  it("does not write when no pending owner exists", async () => {
    const createMany = vi.fn();
    const updateMany = vi.fn();
    const client = {
      $queryRaw: vi.fn(async () => []),
      memoryJob: { createMany, updateMany }
    } as never;
    await expect(reconcileMemoryFactReclassificationJobs(client)).resolves.toBe(0);
    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
