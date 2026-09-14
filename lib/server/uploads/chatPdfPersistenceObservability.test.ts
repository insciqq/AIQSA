import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { databaseFailureCode } from "../observability/databaseFailure";
import { createChatPdfAttempts } from "./chatPdfAttempts";
import { createChatPdfRepository } from "./chatPdfPersistence";
import { ChatPdfPreparationError } from "./chatPdfCore";
import { observeChatPdfPersistence } from "./chatPdfPersistenceObservability";

describe("PDF guarded persistence observations", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([0, 1])("uses affected rows=%i for ambiguity and release, without claiming a no-op", async (count) => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const updateMany = vi.fn(async () => ({ count }));
    const db = { chatPdfPageAttempt: { updateMany }, chatPdfRunPreparation: { updateMany } } as unknown as PrismaClient;
    const attempts = createChatPdfAttempts(db);
    const repo = createChatPdfRepository(db);
    const claim = { runId: "run", userId: "owner", claimToken: "PRIVATE_LEASE_CANARY" };
    expect(await observeChatPdfPersistence("run", "settle", () => attempts.ambiguous({ attemptId: "attempt", usageEventId: "usage" }))).toBe(count === 1);
    expect(await observeChatPdfPersistence("run", "release", () => repo.release(claim))).toBe(count === 1);
    const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.outcome === (count ? "confirmed" : "not_applied"))).toBe(true);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });

  it("retains a proven Prisma code and the identical rejection at the database boundary", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const error = new Prisma.PrismaClientKnownRequestError("PRIVATE_DATABASE_CANARY", { code: "P1001", clientVersion: "test" });
    const db = { chatPdfPageAttempt: { updateMany: vi.fn().mockRejectedValue(error) } } as unknown as PrismaClient;
    await expect(observeChatPdfPersistence("run", "settle", () => createChatPdfAttempts(db).ambiguous({ attemptId: "attempt", usageEventId: "usage" }))).rejects.toBe(error);
    expect(databaseFailureCode(error)).toBe("P1001");
    expect(JSON.parse(String(writer.mock.calls[0]![0]))).toMatchObject({ outcome: "unconfirmed", prisma_code: "P1001" });
    expect(JSON.stringify(writer.mock.calls)).not.toContain("PRIVATE_");
  });

  it.each(["missing", "already_reported", "unavailable", "reported"])("does not confirm skipped usage accounting: %s", async (state) => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const update = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: async () => state === "missing" ? [] : [{ id: "usage", providerModelId: null,
        usageCompleteness: state === "already_reported" ? "COMPLETE" : "UNAVAILABLE" }],
      usageEvent: { update }
    };
    const db = { $transaction: async (operation: (transaction: typeof tx) => Promise<boolean>) => operation(tx) } as unknown as PrismaClient;
    const result = await observeChatPdfPersistence("run", "settle", () => createChatPdfAttempts(db).recordUsage({
      attemptId: "attempt", usageEventId: "usage"
    }, state === "unavailable" ? {} : { inputTokens: 4, outputTokens: 2 }));
    expect(result).toBe(state === "reported");
    expect(update).toHaveBeenCalledTimes(state === "reported" ? 1 : 0);
    expect(JSON.parse(String(writer.mock.calls[0]![0]))).toMatchObject({ outcome: result ? "confirmed" : "not_applied" });
  });

  it.each(["missing", "settled", "dispatched", "ambiguous"])("confirms attempt settlement only when the record changes: %s", async (state) => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const update = vi.fn(async () => ({}));
    const tx = { chatPdfPageAttempt: {
      findUnique: async () => state === "missing" ? null : { state }, update
    } };
    const db = { $transaction: async (operation: (transaction: typeof tx) => Promise<boolean>) => operation(tx) } as unknown as PrismaClient;
    const result = await observeChatPdfPersistence("run", "settle", () => createChatPdfAttempts(db).settle({
      attemptId: "attempt", usageEventId: "usage"
    }, { resultArtifactId: "artifact", usage: { inputTokens: 4, outputTokens: 2 } }));
    expect(result).toBe(state === "dispatched" || state === "ambiguous");
    expect(update).toHaveBeenCalledTimes(result ? 1 : 0);
    expect(JSON.parse(String(writer.mock.calls[0]![0]))).toMatchObject({ outcome: result ? "confirmed" : "not_applied" });
  });

  it("keeps a rejected ownership guard informational and preserves its rejection", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const error = new ChatPdfPreparationError("pdf_preparation_unavailable");
    await expect(observeChatPdfPersistence("run", "publish", async () => { throw error; })).rejects.toBe(error);
    expect(JSON.parse(String(writer.mock.calls[0]![0]))).toMatchObject({ outcome: "not_applied", level: "info" });
  });
});
