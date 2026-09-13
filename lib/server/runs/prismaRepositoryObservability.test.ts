import { Prisma, type PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrismaRunRepository } from "./prismaRepository";
import { logRunPersistence, runDatabaseFailureCode } from "./runObservability";
import type { RunRepository } from "./runRepositoryContract";

describe("Prisma run failure diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [new Prisma.PrismaClientKnownRequestError("PRIVATE_SQL_CANARY", { code: "P2028", clientVersion: "test", meta: { secret: "PRIVATE_META_CANARY" } }), "P2028"],
    [new Prisma.PrismaClientInitializationError("PRIVATE_DB_CONNECTION_CANARY", "test", "P1001"), "P1001"],
    [new Prisma.PrismaClientInitializationError("PRIVATE_DB_CONNECTION_CANARY", "test"), "unknown"],
    [new Prisma.PrismaClientKnownRequestError("PRIVATE_SQL_CANARY", { code: "PRIVATE_CODE_CANARY", clientVersion: "test" }), "unknown"],
    [Object.assign(new Error("PRIVATE_SQL_CANARY P2028"), { code: "P2028", name: "PrismaClientKnownRequestError" }), "unknown"]
  ])("retains only a code proven by the Prisma boundary", async (error, expectedCode) => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const client = { $transaction: vi.fn(async () => { throw error; }) } as unknown as PrismaClient;
    const repository = createPrismaRunRepository(client);
    await expect(repository.failRun("run-safe", "assistant-private", { code: "provider_stream_failed", message: "private" })).rejects.toBe(error);
    logRunPersistence("run-safe", "fail", "unconfirmed", error);
    const output = String(writer.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({ event: "run_persistence", run_id: "run-safe", outcome: "unconfirmed", prisma_code: expectedCode });
    expect(output).not.toMatch(/PRIVATE_|assistant-private|message|meta|stack/);
  });

  it.each<[string, (repository: RunRepository) => Promise<unknown>]>([
    ["chat admission", (repository) => repository.findOwnedChat("chat-safe", "user-safe")],
    ["regeneration admission", (repository) => repository.findRegenerationSource("message-safe", "user-safe")],
    ["run control", (repository) => repository.getRunControlForUser("run-safe", "user-safe")],
    ["attachment admission", (repository) => repository.loadAttachments("user-safe", ["attachment-safe"])],
    ["Search admission", (repository) => repository.isSearchStrategyEnabled("search-safe")],
    ["completion pricing", (repository) => repository.loadModelPricing("fake", "model-safe")]
  ])("retains the original read failure across %s", async (_stage, read) => {
    const error = new Prisma.PrismaClientInitializationError("PRIVATE_DB_CONNECTION_CANARY", "test", "P1001");
    const reject = vi.fn(async () => { throw error; });
    const client = {
      chat: { findFirst: reject }, message: { findFirst: reject }, modelRun: { findFirst: reject },
      attachment: { findMany: reject }, searchOption: { findFirst: reject }, providerModel: { findMany: reject }
    } as unknown as PrismaClient;
    const repository = createPrismaRunRepository(client);
    await expect(read(repository)).rejects.toBe(error);
    expect(reject).toHaveBeenCalledOnce();
    expect(runDatabaseFailureCode(error)).toBe("P1001");
  });
});
