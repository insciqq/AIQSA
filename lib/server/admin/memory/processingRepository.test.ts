import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { readAdminMemoryProcessing } from "./processingRepository";

vi.mock("../../providerRuntime/memoryUtilityModelRole", () => ({
  createMemoryUtilityModelRoleResolver: () => ({ resolve: async () => ({ ok: true }) })
}));

describe("Memory issue aggregation", () => {
  it("preserves each reason and healing state with independent counts and ages regardless of query order", async () => {
    const now = new Date("2026-09-19T12:00:00Z");
    const base = { stage: "HISTORY", count: 1n, oldestAt: new Date(now.getTime() - 120_000) };
    const rows = [
      { ...base, reason: "PROCESSING_FAILED", autoHeal: null },
      { ...base, reason: "HISTORY_INCOMPLETE", autoHeal: "UNAVAILABLE", oldestAt: new Date(now.getTime() - 600_000) },
      { ...base, reason: "HISTORY_INCOMPLETE", autoHeal: "RETRYING", count: 2n },
      { ...base, stage: "INDEXING", reason: "PROCESSING_FAILED", autoHeal: null }
    ];
    const read = (ordered: typeof rows) => readAdminMemoryProcessing({
      $queryRaw: vi.fn().mockResolvedValueOnce([{ enabled: 1n, learning: 0n }]).mockResolvedValueOnce(ordered)
    } as unknown as PrismaClient, now);
    const result = await read(rows);
    expect(result.issues).toEqual([
      { stage: "HISTORY", reason: "PROCESSING_FAILED", count: 1, oldestAgeSeconds: 120, severity: "bad" },
      { stage: "HISTORY", reason: "HISTORY_INCOMPLETE", autoHeal: "RETRYING", count: 2, oldestAgeSeconds: 120, severity: "warn" },
      { stage: "HISTORY", reason: "HISTORY_INCOMPLETE", autoHeal: "UNAVAILABLE", count: 1, oldestAgeSeconds: 600, severity: "warn" },
      { stage: "INDEXING", reason: "PROCESSING_FAILED", count: 1, oldestAgeSeconds: 120, severity: "warn" }
    ]);
    expect(await read([...rows].reverse())).toEqual(result);
  });
});
