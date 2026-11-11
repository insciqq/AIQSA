import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { chatTitleWork } from "@/tests/support/chatTitles";
import { createNativeRunStore } from "../engine/runStore";
import type { RunUsageAttribution } from "../runs/runRepositoryContract";
import { TITLE_USAGE_WRITE_ATTEMPTS, createChatTitleRepository } from "./titleGenerationRepository";

const deadlock = () => new Prisma.PrismaClientKnownRequestError("deadlock detected", {
  clientVersion: "test", code: "P2010", meta: { code: "40P01" }
});

/** A client whose transactions fail with `failures` in turn, then run against a receipt whose usage is still unknown. */
function client(failures: readonly unknown[]) {
  const tx = {
    $queryRaw: vi.fn(async (query: Prisma.Sql) =>
      query.text.includes('"UsageEvent"') ? [{ id: "receipt-1", usageCompleteness: "UNAVAILABLE" }] : []),
    chat: { updateMany: vi.fn(async () => ({ count: 1 })) },
    modelRun: { findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })) },
    providerModel: { findUnique: vi.fn(async () => null) },
    usageEvent: { update: vi.fn(async () => ({})) }
  };
  let attempt = 0;
  const $transaction = vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => {
    const failure = failures[attempt];
    attempt += 1;
    if (failure !== undefined) throw failure;
    return work(tx);
  });
  return { $transaction, tx, prisma: { $transaction } as unknown as PrismaClient };
}

describe("title usage accounting", () => {
  it("locks the chat before its receipt, as the answer's usage totals do", async () => {
    const fake = client([]);
    await createChatTitleRepository(fake.prisma).recordUsage(chatTitleWork(), { inputTokens: 10, outputTokens: 5 });
    const statements = fake.tx.$queryRaw.mock.calls.map(([query]) => query.text);
    expect(statements[0]).toContain('FROM "Chat" WHERE "id" = $1 FOR NO KEY UPDATE');
    expect(statements[1]).toContain('FROM "UsageEvent"');
    expect(fake.tx.$queryRaw.mock.calls[0]![0].values).toEqual(["chat-1"]);
    expect(fake.tx.usageEvent.update).toHaveBeenCalledOnce();
    expect(fake.tx.chat.updateMany).toHaveBeenCalledOnce();
  });

  it("writes the usage again after a deadlock or serialization failure rolled it back", async () => {
    const fake = client([deadlock(), new Prisma.PrismaClientKnownRequestError("conflict", { clientVersion: "test", code: "P2034" })]);
    await createChatTitleRepository(fake.prisma).recordUsage(chatTitleWork(), { inputTokens: 10, outputTokens: 5 });
    expect(fake.$transaction).toHaveBeenCalledTimes(3);
    expect(fake.tx.usageEvent.update).toHaveBeenCalledOnce();
    expect(fake.tx.chat.updateMany).toHaveBeenCalledOnce();
  });

  it("gives up after a bounded number of conflicts", async () => {
    const failures = Array.from({ length: TITLE_USAGE_WRITE_ATTEMPTS }, deadlock);
    const fake = client(failures);
    await expect(createChatTitleRepository(fake.prisma).recordUsage(chatTitleWork(), { inputTokens: 10, outputTokens: 5 }))
      .rejects.toBe(failures.at(-1));
    expect(fake.$transaction).toHaveBeenCalledTimes(TITLE_USAGE_WRITE_ATTEMPTS);
    expect(fake.tx.usageEvent.update).not.toHaveBeenCalled();
  });

  it("never repeats a write that failed for another reason", async () => {
    const failure = new Error("connection lost");
    const fake = client([failure]);
    await expect(createChatTitleRepository(fake.prisma).recordUsage(chatTitleWork(), { inputTokens: 10, outputTokens: 5 }))
      .rejects.toBe(failure);
    expect(fake.$transaction).toHaveBeenCalledOnce();
  });
});

type Row = Record<string, unknown>;
const TOKEN_FIELDS = ["cachedInputTokens", "cacheWriteInputTokens", "inputTokens", "outputTokens", "reasoningTokens", "totalTokens"];
const unknownFigures = () => Object.fromEntries(TOKEN_FIELDS.map((field) => [field, null]));

/**
 * One answer run, its chat and its title's receipt, written by the answer's usage totals (`applyUsageTotals`) and the
 * title's usage (`recordUsage`) through the calls they make, so their order can be chosen.
 */
function ledger() {
  const work = chatTitleWork();
  const run: Row = { engine: "native", estimatedCostMicros: null, id: work.runId, status: "complete", usageCompleteness: "UNAVAILABLE",
    userId: work.userId, ...unknownFigures() };
  const receipt: Row = { estimatedCostMicros: null, id: "receipt-1", usageCompleteness: "UNAVAILABLE", ...unknownFigures() };
  const chat = { totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0 };
  const matches = (row: Row, where: Row) => Object.entries(where).every(([key, value]) => row[key] === value);
  const grow = (data: Record<string, { increment: number }>) => {
    for (const key of ["totalInputTokens", "totalOutputTokens", "totalReasoningTokens"] as const) chat[key] += data[key]?.increment ?? 0;
  };
  const tx = {
    $queryRaw: async (query: Prisma.Sql) =>
      query.text.includes('FROM "UsageEvent"') ? [{ id: receipt.id, usageCompleteness: receipt.usageCompleteness }] : [],
    chat: {
      update: async ({ data }: { data: Record<string, { increment: number }> }) => { grow(data); return {}; },
      updateMany: async ({ data }: { data: Record<string, { increment: number }> }) => { grow(data); return { count: 1 }; }
    },
    message: { updateMany: async () => ({ count: 1 }) },
    modelRun: {
      count: async ({ where }: { where: Row }) => matches(run, where) ? 1 : 0,
      findUnique: async () => ({ ...run }),
      updateMany: async ({ data, where }: { data: Row; where: Row }) => {
        if (!matches(run, where)) return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      }
    },
    providerModel: { findUnique: async () => null },
    usageEvent: {
      findUnique: async () => ({ ...receipt }),
      update: async ({ data }: { data: Row }) => { Object.assign(receipt, data); return {}; }
    }
  };
  const client = { $transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  const scope = { assistantMessageId: "answer-1", chatId: work.chatId, runId: work.runId, userId: work.userId };
  return {
    chat, run,
    answer: (attribution: RunUsageAttribution) => createNativeRunStore(client).applyUsageTotals(scope, [attribution]),
    title: () => createChatTitleRepository(client).recordUsage(work, { inputTokens: 10, outputTokens: 5 })
  };
}

const answerUsage = (usage: RunUsageAttribution["usage"]): RunUsageAttribution => ({ estimatedCostMicros: 5, modelId: "fake-qsa",
  operationCount: 1, provider: "fake", purpose: "chat_answer", usage });

describe("the title's usage and its answer's usage totals", () => {
  it.each(["answer first", "title first"] as const)("count each once on the run and the chat, %s", async (order) => {
    const books = ledger();
    const answer = () => books.answer(answerUsage({ inputTokens: 30, outputTokens: 2 }));
    if (order === "answer first") await answer().then(books.title);
    else await books.title().then(answer);
    // A repeated write after its outcome was lost adds nothing.
    await answer();
    await books.title();
    expect(books.run).toMatchObject({ inputTokens: 40, outputTokens: 7, totalTokens: 47, usageCompleteness: "COMPLETE" });
    expect(books.chat).toEqual({ totalInputTokens: 40, totalOutputTokens: 7, totalReasoningTokens: 0 });
  });

  it.each(["answer first", "title first"] as const)("keep the title's usage when the answer's is unknown, %s", async (order) => {
    const books = ledger();
    const answer = () => books.answer(answerUsage({}));
    if (order === "answer first") await answer().then(books.title);
    else await books.title().then(answer);
    expect(books.run).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15, usageCompleteness: "PARTIAL" });
    expect(books.chat).toEqual({ totalInputTokens: 10, totalOutputTokens: 5, totalReasoningTokens: 0 });
  });
});
