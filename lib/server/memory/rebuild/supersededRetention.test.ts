import { describe, expect, it, vi } from "vitest";

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../../observability", () => ({ logEvent }));

import {
  MEMORY_SUPERSEDED_ENTRY_PRUNE_BATCH,
  MEMORY_SUPERSEDED_ENTRY_PRUNE_MAX_BATCHES,
  pruneSupersededMemorySearchEntries,
  type MemorySupersededEntryPruneStore
} from "./supersededRetention";

/** An in-memory store: each owner holds a number of prunable entries. */
function store(initial: Record<string, number>, failing: readonly string[] = []) {
  const remaining = new Map(Object.entries(initial));
  const calls: Array<Readonly<{ limit: number; userId: string }>> = [];
  const ownerLimits: number[] = [];
  const fake: MemorySupersededEntryPruneStore = {
    owners: async (limit) => {
      ownerLimits.push(limit);
      return [...remaining].filter(([, count]) => count > 0).map(([userId]) => userId).slice(0, limit);
    },
    pruneBatch: async (userId, limit) => {
      calls.push({ limit, userId });
      if (failing.includes(userId)) throw new Error(`prune_failed_${userId}`);
      const count = remaining.get(userId) ?? 0;
      const deleted = Math.min(count, limit);
      remaining.set(userId, count - deleted);
      return deleted;
    }
  };
  return { calls, fake, ownerLimits, remaining };
}

describe("superseded Memory search entry retention", () => {
  it("bounds one pass by its batch size and batch cap", async () => {
    const { calls, fake, ownerLimits, remaining } = store({ "user-a": 23 });
    await expect(pruneSupersededMemorySearchEntries(fake, { batchEntries: 5, maxBatches: 3 }))
      .resolves.toEqual({ batches: 3, deletedEntries: 15 });
    expect(ownerLimits).toEqual([3]);
    expect(calls).toEqual(Array.from({ length: 3 }, () => ({ limit: 5, userId: "user-a" })));
    expect(remaining.get("user-a")).toBe(8);
  });

  it("continues across passes until nothing is left, then changes nothing", async () => {
    const { calls, fake, remaining } = store({ "user-a": 7, "user-b": 4 });
    const limits = { batchEntries: 3, maxBatches: 2 };
    await expect(pruneSupersededMemorySearchEntries(fake, limits)).resolves.toEqual({ batches: 2, deletedEntries: 6 });
    await expect(pruneSupersededMemorySearchEntries(fake, limits)).resolves.toEqual({ batches: 2, deletedEntries: 4 });
    await expect(pruneSupersededMemorySearchEntries(fake, limits)).resolves.toEqual({ batches: 1, deletedEntries: 1 });
    expect([...remaining.values()]).toEqual([0, 0]);
    const settled = calls.length;
    await expect(pruneSupersededMemorySearchEntries(fake, limits)).resolves.toEqual({ batches: 0, deletedEntries: 0 });
    expect(calls).toHaveLength(settled);
  });

  it("moves to the next owner after a short batch and shares the cap across owners", async () => {
    const { calls, fake } = store({ "user-a": 2, "user-b": 10, "user-c": 10 });
    await expect(pruneSupersededMemorySearchEntries(fake, { batchEntries: 4, maxBatches: 3 }))
      .resolves.toEqual({ batches: 3, deletedEntries: 10 });
    expect(calls.map(({ userId }) => userId)).toEqual(["user-a", "user-b", "user-b"]);
  });

  it("runs the remaining owners when one fails and rethrows that failure", async () => {
    const { calls, fake, remaining } = store({ "user-a": 3, "user-b": 3 }, ["user-a"]);
    await expect(pruneSupersededMemorySearchEntries(fake, { batchEntries: 5, maxBatches: 4 }))
      .rejects.toThrow("prune_failed_user-a");
    expect(calls.map(({ userId }) => userId)).toEqual(["user-a", "user-b"]);
    expect(remaining.get("user-b")).toBe(0);
  });

  it("logs only a content-free count of deleted entries", async () => {
    logEvent.mockClear();
    const { fake } = store({ "PRIVATE_USER": 2 });
    await pruneSupersededMemorySearchEntries(fake, { batchEntries: 5, maxBatches: 1 });
    expect(logEvent).toHaveBeenCalledWith("runtime_lifecycle", {
      code: "memory_superseded_entries_pruned",
      count: 2,
      outcome: "completed",
      stage: "cleanup",
      subsystem: "memory"
    });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("PRIVATE_");
    logEvent.mockClear();
    await pruneSupersededMemorySearchEntries(fake, { batchEntries: 5, maxBatches: 1 });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("rejects unbounded limits and keeps production bounds small", async () => {
    const { fake } = store({});
    for (const limits of [
      { batchEntries: 0, maxBatches: 1 },
      { batchEntries: 1, maxBatches: 0 },
      { batchEntries: 1.5, maxBatches: 1 },
      { batchEntries: Number.POSITIVE_INFINITY, maxBatches: 1 }
    ]) {
      await expect(pruneSupersededMemorySearchEntries(fake, limits))
        .rejects.toThrow("memory_superseded_entry_prune_limits_invalid");
    }
    expect(MEMORY_SUPERSEDED_ENTRY_PRUNE_BATCH).toBe(500);
    expect(MEMORY_SUPERSEDED_ENTRY_PRUNE_MAX_BATCHES).toBe(8);
  });
});
