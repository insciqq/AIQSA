// @vitest-environment node
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleMemoryLexicalProjectionSuccess, settleMemoryLexicalProjectionFailure, type MemoryLexicalProjectionClaim } from "./repository";

afterEach(() => vi.restoreAllMocks());
const claim: MemoryLexicalProjectionClaim = {
  id: "projection-1", attemptCount: 2, indexGenerationId: "private-generation", leaseToken: "private-lease",
  memoryRevisionSnapshot: 3, operation: "SYNC_ENTRY", searchEntryId: "private-entry", sequence: 17n, userId: "private-user"
};

describe("Memory projection retry evidence", () => {
  it.each([1, 0, "rejected"] as const)("reports only a confirmed retry time for settlement %s", async result => {
    const records: Record<string, unknown>[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(line => { records.push(JSON.parse(String(line))); return true; });
    const failure = new Prisma.PrismaClientKnownRequestError("PRIVATE_DATABASE_CANARY", { clientVersion: "test", code: "P1001" });
    const eventUpdate = vi.fn(async () => {
      if (result === "rejected") throw failure;
      return { count: result };
    });
    const client = {
      memoryLexicalProjectionEvent: { updateMany: eventUpdate },
      memoryLexicalProjectionState: { updateMany: vi.fn(async () => ({ count: 1 })) }
    } as unknown as PrismaClient;
    const operation = settleMemoryLexicalProjectionFailure(client, claim, {
      errorCode: "opensearch_timeout", maximumAttempts: 5, now: new Date("2026-09-13T12:00:00.000Z")
    });
    if (result === "rejected") await expect(operation).rejects.toBe(failure);
    else await operation;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: "job_persistence", job_id: "projection-1", stage: "retry",
      outcome: result === 1 ? "confirmed" : result === 0 ? "not_applied" : "unconfirmed" });
    if (result === 1) expect(records[0].retry_at).toBe("2026-09-13T12:00:02.017Z");
    else expect(records[0]).not.toHaveProperty("retry_at");
    if (result === "rejected") expect(records[0].prisma_code).toBe("P1001");
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_DATABASE|private-generation|private-lease|private-entry|private-user/);
  });
});


describe("Memory projection success settlement evidence", () => {
  it.each(["user_purge_not_final", "generation_missing", "lease_lost", "state_missing", "database"])(
    "distinguishes local rollback from an unconfirmed transaction: %s", async failure => {
      const records: Record<string, unknown>[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation(line => { records.push(JSON.parse(String(line))); return true; });
      const selected = { ...claim, operation: failure === "user_purge_not_final" ? "PURGE_USER" as const : "SYNC_ENTRY" as const,
        indexGenerationId: failure === "generation_missing" ? null : claim.indexGenerationId };
      const error = new Prisma.PrismaClientKnownRequestError("PRIVATE_DATABASE", { clientVersion: "test", code: "P1001" });
      const tx = { memoryLexicalProjectionEvent: {
        count: async () => 1, updateMany: async () => ({ count: failure === "lease_lost" ? 0 : 1 })
      }, $executeRaw: async () => 0 };
      const client = { $transaction: async (run: (transaction: typeof tx) => Promise<void>) => {
        if (failure === "database") throw error;
        return run(tx);
      } } as unknown as PrismaClient;
      const result = settleMemoryLexicalProjectionSuccess(client, selected, new Date("2026-09-14T00:00:00Z"));
      if (failure === "database") await expect(result).rejects.toBe(error);
      else await expect(result).rejects.toThrow(`memory_lexical_projection_${failure}`);
      expect(records).toEqual([expect.objectContaining({ event: "job_persistence", stage: "complete",
        outcome: failure === "database" ? "unconfirmed" : "not_applied", level: failure === "database" ? "error" : "info" })]);
      expect(JSON.stringify(records)).not.toContain("PRIVATE_DATABASE");
    }
  );
});
