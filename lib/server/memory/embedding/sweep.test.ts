import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  createPrismaMemoryEmbeddingSweep,
  MEMORY_EMBEDDING_SWEEP_INTERVAL_MS
} from "./sweep";

function emptyClient() {
  const queryRaw = vi.fn(async () => []);
  return { client: { $queryRaw: queryRaw } as unknown as PrismaClient, queryRaw };
}

describe("Memory embedding sweep", () => {
  it("reads at most once per interval from the per-second discovery pass", async () => {
    const { client, queryRaw } = emptyClient();
    const sweep = createPrismaMemoryEmbeddingSweep(client);
    const start = new Date("2026-10-05T12:00:00.000Z");

    await expect(sweep.reconcile(start)).resolves.toBe(0);
    for (let second = 1; second < MEMORY_EMBEDDING_SWEEP_INTERVAL_MS / 1_000; second += 1) {
      await sweep.reconcile(new Date(start.getTime() + second * 1_000));
    }
    expect(queryRaw).toHaveBeenCalledOnce();

    await sweep.reconcile(new Date(start.getTime() + MEMORY_EMBEDDING_SWEEP_INTERVAL_MS));
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
