// @vitest-environment node
import { Prisma, type PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../observability", () => ({ logEvent }));

import { backfillCatalogCostBatch, runCatalogCostBackfill } from "./catalogCostBackfill";

type Usage = { id: string; provider: string; modelId: string; providerModelId: string | null; modelRunId: string | null;
  memoryExecutionBindingId: string | null; createdAt: Date; usageCompleteness: string; estimatedCostMicros: number | null;
  imageGeneration: boolean; optionalDecision: boolean; chatPdfPreparation: boolean; chatTitleGeneration: boolean;
  visionAnalysis: boolean; knowledgeRelevance: boolean;
  inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: null; outputTokens: number; reasoningTokens: null; totalTokens: number };
type Run = { id: string; provider: string; modelId: string; status: string; createdAt: Date; updatedAt: Date;
  usageCompleteness: string; estimatedCostMicros: number | null; answerProviderModelId: string | null;
  inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: null; outputTokens: number; reasoningTokens: null; totalTokens: number };
type State = { id: string; cutoffAt: Date; prices: unknown; usageCursor: string | null; runCursor: string | null;
  usageFinished: boolean; completedAt: Date | null };
type Store = { state: State; usage: Usage[]; runs: Run[] };

const STATE_ID = "20260930";
const OLD = new Date("2026-01-01T00:00:00.000Z");
const counts = { inputTokens: 10_000, cachedInputTokens: 8_000, cacheWriteInputTokens: null, outputTokens: 1_000,
  reasoningTokens: null, totalTokens: 11_000 };
const PRICE = { id: "model-1", provider: "connection-1", modelId: "upstream-1", inputTokenPriceUsdPerMillion: 2,
  cachedInputTokenPriceUsdPerMillion: 0.2, cacheWriteInputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: 10 };
const COST = 15_600;

function usage(id: string, patch: Partial<Usage> = {}): Usage {
  return { id, provider: PRICE.provider, modelId: PRICE.modelId, providerModelId: null, modelRunId: null,
    memoryExecutionBindingId: null, createdAt: OLD, usageCompleteness: "COMPLETE", estimatedCostMicros: null,
    imageGeneration: false, optionalDecision: false, chatPdfPreparation: false, chatTitleGeneration: false,
    visionAnalysis: false, knowledgeRelevance: false, ...counts, ...patch };
}

function run(id: string, patch: Partial<Run> = {}): Run {
  return { id, provider: PRICE.provider, modelId: PRICE.modelId, status: "complete", createdAt: OLD,
    updatedAt: new Date("2026-01-01T00:00:05.000Z"), usageCompleteness: "COMPLETE", estimatedCostMicros: null,
    answerProviderModelId: null, ...counts, ...patch };
}

function databaseError(sqlState: string) {
  return new Prisma.PrismaClientKnownRequestError("synthetic rejection", { code: "P2010", clientVersion: "test",
    meta: { code: sqlState } });
}

type Where = Record<string, unknown>;
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const { lte, gt, in: within } = condition as { lte?: Date; gt?: string; in?: unknown[] };
      return (lte === undefined || (value as Date) <= lte) && (gt === undefined || (value as string) > gt) &&
        (within === undefined || within.includes(value));
    }
    return value === condition;
  });
}

const clone = (store: Store): Store => structuredClone(store);

/** A client that commits a working copy, honors savepoints and records SQL. */
function fakeDatabase(initial: Store, reject: (table: string, id: string) => unknown = () => undefined) {
  let committed = clone(initial);
  const sql: string[] = [];
  const takes: number[] = [];
  const db = {
    async $transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      let working = clone(committed);
      let savepoint: Store | null = null;
      const tx = {
        $queryRaw: async () => [],
        $queryRawUnsafe: async (text: string) => { sql.push(text); return []; },
        async $executeRawUnsafe(text: string) {
          sql.push(text);
          if (text.startsWith("SAVEPOINT")) savepoint = clone(working);
          if (text.startsWith("ROLLBACK TO SAVEPOINT")) working = clone(savepoint!);
          return 0;
        },
        async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
          const text = strings.join("?");
          sql.push(text);
          const [cost, id] = values as [number, string];
          const table = text.includes("\"ModelRun\"") ? "ModelRun" : "UsageEvent";
          const failure = reject(table, id);
          if (failure) throw failure;
          const rows: Array<{ id: string; estimatedCostMicros: number | null }> = table === "ModelRun" ? working.runs : working.usage;
          const row = rows.find(candidate => candidate.id === id && candidate.estimatedCostMicros === null);
          if (row) row.estimatedCostMicros = cost;
          return row ? 1 : 0;
        },
        catalogCostBackfill: {
          findUnique: async () => clone(working).state,
          async update({ data }: { data: Partial<State> }) { Object.assign(working.state, data); return working.state; }
        },
        usageEvent: {
          async findMany({ where, take }: { where: Where; take: number }) {
            takes.push(take);
            return working.usage.filter(row => matches(row, where)).sort((a, b) => a.id < b.id ? -1 : 1).slice(0, take)
              .map(row => structuredClone(row));
          }
        },
        modelRun: {
          async findMany({ where, take }: { where: Where; take: number }) {
            takes.push(take);
            return working.runs.filter(row => matches(row, where)).sort((a, b) => a.id < b.id ? -1 : 1).slice(0, take)
              .map(row => ({ ...structuredClone(row),
                providerRunBindings: row.answerProviderModelId ? [{ providerModelId: row.answerProviderModelId }] : [],
                usageEvents: working.usage.filter(event => event.modelRunId === row.id && !event.chatPdfPreparation &&
                  !event.imageGeneration && !event.chatTitleGeneration && !event.visionAnalysis && !event.knowledgeRelevance &&
                  !event.optionalDecision).map(event => ({ estimatedCostMicros: event.estimatedCostMicros })) }));
          }
        }
      };
      const result = await work(tx);
      committed = working;
      return result;
    }
  };
  return { db: db as unknown as PrismaClient, sql, takes, read: () => clone(committed) };
}

function store(patch: Partial<Store> = {}): Store {
  return { state: { id: STATE_ID, cutoffAt: new Date("2026-09-30T00:00:00.000Z"), prices: [PRICE], usageCursor: null,
    runCursor: null, usageFinished: false, completedAt: null }, usage: [], runs: [], ...patch };
}

const noSleep = async () => {};

beforeEach(() => logEvent.mockReset());

describe("catalog cost backfill", () => {
  it("updates the other rows of a batch around a rejected row, moves the cursor past it and reports it", async () => {
    const database = fakeDatabase(store({ usage: [usage("u-a"), usage("u-b"), usage("u-c")] }),
      (table, id) => id === "u-b" ? databaseError("23514") : undefined);
    expect(await backfillCatalogCostBatch(database.db)).toEqual({ more: true, skipped: 1, completed: false });
    const after = database.read();
    expect(after.usage.map(row => row.estimatedCostMicros)).toEqual([COST, null, COST]);
    expect(after.state).toMatchObject({ usageCursor: "u-c", usageFinished: true });
    // Deferred constraint triggers fire per statement, inside the row's savepoint.
    expect(database.sql.indexOf("SET CONSTRAINTS ALL IMMEDIATE")).toBeLessThan(database.sql.findIndex(text => text.startsWith("UPDATE")));
  });

  it("isolates a run rejected by a constraint trigger and completes, ending the guard bypass", async () => {
    const database = fakeDatabase(store({ runs: [run("r-a"), run("r-b"), run("r-c")] }),
      (table, id) => table === "ModelRun" && id === "r-b" ? databaseError("P0001") : undefined);
    await runCatalogCostBackfill(database.db, { sleep: noSleep });
    const after = database.read();
    expect(after.runs.map(row => row.estimatedCostMicros)).toEqual([COST, null, COST]);
    expect(after.state).toMatchObject({ runCursor: "r-c", prices: [] });
    expect(after.state.completedAt).toBeInstanceOf(Date);
    expect(logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({
      outcome: "skipped", code: "catalog_cost_backfill_row_skipped", count: 1 }));
    expect(logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({ outcome: "completed" }));
  });

  it("rolls back the whole batch on contention and skips the row only on the last attempt", async () => {
    const deadlock = () => fakeDatabase(store({ usage: [usage("u-a"), usage("u-b"), usage("u-c")] }),
      (table, id) => id === "u-b" ? databaseError("40P01") : undefined);
    const retried = deadlock();
    await expect(backfillCatalogCostBatch(retried.db)).rejects.toThrow("catalog_cost_backfill_row_transient");
    expect(retried.read()).toEqual(store({ usage: [usage("u-a"), usage("u-b"), usage("u-c")] }));
    const last = deadlock();
    expect(await backfillCatalogCostBatch(last.db, STATE_ID, { skipTransient: true })).toMatchObject({ skipped: 1 });
    expect(last.read().usage.map(row => row.estimatedCostMicros)).toEqual([COST, null, COST]);
  });

  it("retries in process with a bounded backoff and a shrinking batch until a stuck row is skipped", async () => {
    const database = fakeDatabase(store({ usage: [usage("u-a"), usage("u-b"), usage("u-c")] }),
      (table, id) => id === "u-b" ? databaseError("55P03") : undefined);
    const sleep = vi.fn<(ms: number) => Promise<void>>(noSleep);
    await runCatalogCostBackfill(database.db, { sleep });
    const after = database.read();
    expect(after.usage.map(row => row.estimatedCostMicros)).toEqual([COST, null, COST]);
    expect(after.state.completedAt).toBeInstanceOf(Date);
    const delays = sleep.mock.calls.map(([ms]) => ms).filter(ms => ms > 25);
    expect(delays).toEqual([1_000, 5_000, 20_000, 60_000, 1_000, 5_000, 20_000, 60_000]);
    expect(database.takes.slice(0, 5)).toEqual([250, 62, 15, 3, 1]);
    expect(logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({
      code: "catalog_cost_backfill_failed", action: "retry", prisma_code: "P2010" }));
  });

  it("stops after the bounded retries when the database stays unavailable and resumes later", async () => {
    const unavailable = new Prisma.PrismaClientKnownRequestError("synthetic outage", { code: "P1001", clientVersion: "test" });
    const transaction = vi.fn(async () => { throw unavailable; });
    const sleep = vi.fn<(ms: number) => Promise<void>>(noSleep);
    await runCatalogCostBackfill({ $transaction: transaction } as unknown as PrismaClient, { sleep });
    expect(transaction).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 5_000, 20_000, 60_000]);
    expect(logEvent).toHaveBeenLastCalledWith("service_operation", expect.objectContaining({
      outcome: "degraded", action: "stop", code: "catalog_cost_backfill_failed", prisma_code: "P1001" }));
  });

  it("keeps a Memory receipt without cost", async () => {
    const database = fakeDatabase(store({ usage: [usage("u-a", { providerModelId: PRICE.id, memoryExecutionBindingId: "binding-1" })] }));
    await runCatalogCostBackfill(database.db, { sleep: noSleep });
    expect(database.read().usage[0]!.estimatedCostMicros).toBeNull();
    expect(database.read().state.completedAt).toBeInstanceOf(Date);
  });

  it("changes only the run cost and keeps its updatedAt", async () => {
    const database = fakeDatabase(store({ runs: [run("r-a", { answerProviderModelId: PRICE.id })],
      usage: [usage("u-a", { modelRunId: "r-a" })] }));
    await runCatalogCostBackfill(database.db, { sleep: noSleep });
    const [after] = database.read().runs;
    expect(after).toEqual(run("r-a", { answerProviderModelId: PRICE.id, estimatedCostMicros: COST }));
    const update = database.sql.find(text => text.startsWith("UPDATE \"ModelRun\""))!;
    expect(update).not.toContain("updatedAt");
  });

  it("prices a historical chat-summary receipt by the ProviderModel id it stores", async () => {
    const database = fakeDatabase(store({ usage: [usage("chat-summary:c:a:0", { provider: "openai", modelId: PRICE.id })] }));
    await runCatalogCostBackfill(database.db, { sleep: noSleep });
    expect(database.read().usage[0]!.estimatedCostMicros).toBe(COST);
  });

  it("changes nothing on a second execution and never touches an existing cost", async () => {
    const initial = store({ usage: [usage("u-a", { modelRunId: "r-a" }), usage("u-b", { estimatedCostMicros: 7 }),
      usage("u-c", { usageCompleteness: "PARTIAL" })],
    runs: [run("r-a"), run("r-b", { estimatedCostMicros: 123 })] });
    const database = fakeDatabase(initial);
    await runCatalogCostBackfill(database.db, { sleep: noSleep });
    const first = database.read();
    expect(first.usage.map(row => row.estimatedCostMicros)).toEqual([COST, 7, null]);
    expect(first.runs.map(row => row.estimatedCostMicros)).toEqual([COST, 123]);
    const updates = database.sql.filter(text => text.startsWith("UPDATE")).length;
    await runCatalogCostBackfill(database.db, { sleep: noSleep });
    expect(database.read()).toEqual(first);
    expect(database.sql.filter(text => text.startsWith("UPDATE"))).toHaveLength(updates);
  });
});
