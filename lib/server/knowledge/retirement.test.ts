import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeDeletionDrainSummary } from "./deletionProcessor";
import { createKnowledgeRetirement } from "./retirement";

const drained: KnowledgeDeletionDrainSummary = { blocked: 0, claimed: 2, completed: 2, failed: 0, waitingForObjects: 0 };

function fixture(pages: string[][]) {
  const queries: unknown[][] = [];
  const transactions: string[] = [];
  const client = {
    $queryRaw: vi.fn(async (sql: { values: unknown[] }) => {
      queries.push(sql.values);
      return (pages.shift() ?? []).map((ownerUserId) => ({ ownerUserId }));
    }),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ kind: "tx" }))
  } as unknown as PrismaClient;
  const advance = vi.fn(async (_tx: unknown, input: { userId: string }) => {
    transactions.push(input.userId);
    if (input.userId === "broken") throw new Error("knowledge_account_deletion_settlement_invalid");
    return { admitted: true, deletionPending: true, readyForUserDeletion: false };
  });
  const drain = vi.fn(async () => drained);
  const dropSearchIndex = vi.fn(async () => undefined);
  const retire = createKnowledgeRetirement({
    advance, client, drain, dropSearchIndex, now: () => new Date("2026-10-23T12:00:00.000Z"), ownerBatch: 2
  });
  return { advance, drain, dropSearchIndex, queries, retire, transactions };
}

describe("Knowledge retirement", () => {
  it("stages a bounded batch of owners, each in its own transaction, then drains their jobs", async () => {
    const f = fixture([["owner-a", "owner-b"]]);
    await expect(f.retire()).resolves.toEqual({ done: false, drain: drained, failedOwners: 0, owners: 2 });
    expect(f.transactions).toEqual(["owner-a", "owner-b"]);
    expect(f.advance).toHaveBeenCalledWith({ kind: "tx" }, { now: new Date("2026-10-23T12:00:00.000Z"), userId: "owner-a" });
    expect(f.drain).toHaveBeenCalledOnce();
    expect(f.dropSearchIndex).not.toHaveBeenCalled();
  });

  it("rotates through owners so one that keeps failing never starves the rest", async () => {
    const f = fixture([["broken", "owner-b"], ["owner-c"], ["broken"]]);
    await expect(f.retire()).resolves.toMatchObject({ failedOwners: 1, owners: 2 });
    await expect(f.retire()).resolves.toMatchObject({ failedOwners: 0, owners: 1 });
    await f.retire();
    // The second page starts after the last owner of a full first page; a short page starts over.
    expect(f.queries.map((values) => values[0])).toEqual(["", "owner-b", ""]);
    expect(f.transactions).toEqual(["broken", "owner-b", "owner-c", "broken"]);
    expect(f.drain).toHaveBeenCalledTimes(3);
  });

  it("starts over at the end of a rotation without treating it as done", async () => {
    const f = fixture([["owner-a", "owner-b"], []]);
    await f.retire();
    await expect(f.retire()).resolves.toBeNull();
    expect(f.dropSearchIndex).not.toHaveBeenCalled();
    expect(f.queries.map((values) => values[0])).toEqual(["", "owner-b"]);
  });

  it("removes the search index once nothing is left and then stays idle", async () => {
    const f = fixture([[]]);
    await expect(f.retire()).resolves.toEqual({ done: true, drain: null, failedOwners: 0, owners: 0 });
    await expect(f.retire()).resolves.toBeNull();
    expect(f.dropSearchIndex).toHaveBeenCalledOnce();
    expect(f.queries).toHaveLength(1);
    expect(f.drain).not.toHaveBeenCalled();
  });

  it("stops early when the pass is cancelled", async () => {
    const f = fixture([["owner-a", "owner-b"]]);
    const controller = new AbortController();
    controller.abort();
    await expect(f.retire(controller.signal)).rejects.toThrow();
    expect(f.transactions).toEqual([]);
    expect(f.drain).not.toHaveBeenCalled();
  });
});
