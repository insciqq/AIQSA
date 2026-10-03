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
        .mockResolvedValueOnce([])
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

  it("adds 24-hour command and search outcomes as warn-only allowlisted aggregates", async () => {
    const now = new Date("2026-09-19T12:00:00Z");
    const result = await readAdminMemoryProcessing({
      $queryRaw: vi.fn().mockResolvedValueOnce([{ enabled: 1n, learning: 0n }]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { stage: "SEARCH", reason: "SEARCH_FAILED", count: 2n, oldestAt: new Date(now.getTime() - 3_600_000) },
          { stage: "COMMAND", reason: "COMMAND_UNKNOWN", count: 1n, oldestAt: new Date(now.getTime() - 60_000) },
          { stage: "COMMAND", reason: "COMMAND_FAILED", count: 3n, oldestAt: new Date(now.getTime() - 7_200_000) }
        ])
    } as unknown as PrismaClient, now);
    expect(result.issues).toEqual([
      { stage: "COMMAND", reason: "COMMAND_FAILED", count: 3, oldestAgeSeconds: 7200, severity: "warn" },
      { stage: "COMMAND", reason: "COMMAND_UNKNOWN", count: 1, oldestAgeSeconds: 60, severity: "warn" },
      { stage: "SEARCH", reason: "SEARCH_FAILED", count: 2, oldestAgeSeconds: 3600, severity: "warn" }
    ]);
  });

  it("adds 24-hour preparation fallbacks and safe stops by allowlisted codes only", async () => {
    const now = new Date("2026-09-19T12:00:00Z");
    const queryRaw = vi.fn().mockResolvedValueOnce([{ enabled: 1n, learning: 0n }]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { stage: "PREPARATION", reason: "PREPARATION_SKIPPED", count: 4n, oldestAt: new Date(now.getTime() - 600_000) },
        { stage: "PREPARATION", reason: "PREPARATION_FAILED", count: 1n, oldestAt: new Date(now.getTime() - 60_000) }
      ]);
    const result = await readAdminMemoryProcessing({ $queryRaw: queryRaw } as unknown as PrismaClient, now);
    expect(result.issues).toEqual([
      { stage: "PREPARATION", reason: "PREPARATION_FAILED", count: 1, oldestAgeSeconds: 60, severity: "warn" },
      { stage: "PREPARATION", reason: "PREPARATION_SKIPPED", count: 4, oldestAgeSeconds: 600, severity: "warn" }
    ]);
    const recent = queryRaw.mock.calls[2]![0] as { sql: string; values: unknown[] };
    expect(recent.sql).toContain('"ModelRunMemoryBinding"');
    expect(recent.sql).toContain("\"degradationCode\" IS NOT NULL");
    expect(recent.sql).toContain("owner.status = 'active'");
    expect(recent.sql).not.toMatch(/LIKE\s+'memory_/);
    expect(recent.values).toEqual(expect.arrayContaining(["memory_preparing_failed", "memory_source_deleted",
      "memory_item_forgotten", "memory_all_reusable_deleted", "memory_source_stale", "memory_preparing_recovery_required"]));
    expect(recent.values).not.toContain("memory_answer_model_tools_retired");
  });
});
