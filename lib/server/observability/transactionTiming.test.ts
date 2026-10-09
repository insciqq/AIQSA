// @vitest-environment node
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbTransactionJobKind, DbTransactionOperation } from "./events";
import { serializeEvent } from "./runtime.cjs";
import {
  DB_TRANSACTION_FOREGROUND_BUDGET_MS,
  DB_TRANSACTION_SLOW_MS,
  isLockStatement,
  measureTransaction,
  observeTransactionTimings,
  transactionTimingFields,
  transactionTimingOf,
  type DbTransactionTiming
} from "./transactionTiming";

type FakeTx = {
  $queryRaw: (...args: unknown[]) => Promise<unknown>;
  $executeRawUnsafe: (...args: unknown[]) => Promise<unknown>;
  chat: { findFirst: (input: unknown) => Promise<unknown> };
};

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const lockTimeout = () => new Prisma.PrismaClientKnownRequestError("PRIVATE_SQL_CANARY", { clientVersion: "test", code: "P2010",
  meta: { code: "55P03", message: "canceling statement due to lock timeout" } });

/** A transaction client whose lock statements wait `lockMs` (then fail with `lockFailure`), everything else at once. */
function fakeTx(lockMs: number, lockFailure?: () => unknown) {
  const statements: string[] = [];
  const raw = async (...args: unknown[]) => {
    const first = args[0] as { strings?: string[] } | string[] | string;
    const text = typeof first === "string" ? first : Array.isArray(first) ? first.join("?") : (first.strings ?? []).join("?");
    statements.push(text);
    if (/FOR (UPDATE|SHARE)/u.test(text)) {
      await sleep(lockMs);
      if (lockFailure) throw lockFailure();
    }
    return [{ id: "row" }];
  };
  const tx: FakeTx = { $queryRaw: vi.fn(raw), $executeRawUnsafe: vi.fn(raw), chat: { findFirst: vi.fn(async () => ({ id: "chat" })) } };
  return { statements, tx };
}

/** A `$transaction` that runs the body at once, like Prisma's interactive transaction, and counts its starts. */
function begin(tx: FakeTx) {
  const starts: number[] = [];
  const run = async <R>(body: (value: FakeTx) => Promise<R>): Promise<R> => {
    starts.push(starts.length + 1);
    return body(tx);
  };
  return Object.assign(run, { starts });
}

function records(): Record<string, unknown>[] {
  return output.flatMap((chunk) => {
    try { return [JSON.parse(String(chunk)) as Record<string, unknown>]; } catch { return []; }
  }).filter((record) => record.event === "db_transaction");
}

let output: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { output.push(String(chunk)); return true; });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("transaction timing", () => {
  it("recognizes row, table and advisory lock statements in every raw query form", () => {
    const chat = "chat_1";
    expect(isLockStatement(Prisma.sql`SELECT "id" FROM "Chat" WHERE "id" = ${chat} FOR UPDATE`.strings.join("?"))).toBe(true);
    expect(isLockStatement(Prisma.sql`SELECT 1 FROM "Chat" WHERE "id" = ${chat} ${Prisma.sql`FOR SHARE`}`.strings.join("?"))).toBe(true);
    expect(isLockStatement("SELECT 1 FROM \"MemoryJob\" FOR UPDATE OF job SKIP LOCKED")).toBe(true);
    expect(isLockStatement("SELECT 1 FROM t FOR NO KEY UPDATE")).toBe(true);
    expect(isLockStatement("SELECT 1 FROM t FOR KEY SHARE")).toBe(true);
    expect(isLockStatement("LOCK TABLE \"Chat\" IN SHARE MODE")).toBe(true);
    expect(isLockStatement("SELECT pg_advisory_xact_lock($1)")).toBe(true);
    expect(isLockStatement("SELECT set_config('lock_timeout', $1, true)")).toBe(false);
    expect(isLockStatement("UPDATE \"MemoryJob\" SET \"state\" = 'SUCCEEDED' WHERE \"id\" = $1")).toBe(false);
    expect(isLockStatement("SELECT \"formatted\" FROM \"Message\"")).toBe(false);
  });

  it("reports a commit that held rows past the foreground budget as an error with its operation, job kind, hold and lock wait", async () => {
    const { tx } = fakeTx(1_500);
    const transaction = begin(tx);
    const pending = measureTransaction({ subsystem: "memory", operation: "job_commit", job_kind: "INDEX_HISTORY" }, async (client: FakeTx) => {
      await client.$queryRaw(Prisma.sql`SELECT set_config('lock_timeout', ${"1000ms"}, true)`);
      await client.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${"PRIVATE_CHAT_ID"} FOR SHARE`;
      await client.chat.findFirst({ where: { id: "PRIVATE_CHAT_ID" } });
      await sleep(4_600);
      return "applied";
    }, transaction);
    await vi.advanceTimersByTimeAsync(6_100);
    await expect(pending).resolves.toBe("applied");
    expect(transaction.starts).toEqual([1]);
    const [record] = records();
    expect(record).toMatchObject({ level: "error", event: "db_transaction", subsystem: "memory", operation: "job_commit",
      job_kind: "INDEX_HISTORY", duration_ms: 6_100, lock_wait_ms: 1_500, outcome: "committed" });
    expect(records()).toHaveLength(1);
    // Content-free: no statement, value or row identity.
    expect(JSON.stringify(record)).not.toMatch(/PRIVATE_|SELECT|Chat"|lock_timeout|db_failure/u);
  });

  it.each([
    [DB_TRANSACTION_SLOW_MS, null],
    [DB_TRANSACTION_SLOW_MS + 1, "warn"],
    [DB_TRANSACTION_FOREGROUND_BUDGET_MS, "warn"],
    [DB_TRANSACTION_FOREGROUND_BUDGET_MS + 1, "error"]
  ] as const)("logs a transaction held %i ms at level %s", async (heldMs, level) => {
    const { tx } = fakeTx(0);
    const observed: DbTransactionTiming[] = [];
    const pending = observeTransactionTimings(() => measureTransaction({ subsystem: "runs", operation: "run_complete" }, async () => {
      await sleep(heldMs);
      return true;
    }, begin(tx)), (timing) => observed.push(timing));
    await vi.advanceTimersByTimeAsync(heldMs);
    await expect(pending).resolves.toBe(true);
    expect(observed).toEqual([{ duration_ms: heldMs, lock_wait_ms: 0, outcome: "committed" }]);
    expect(records()).toEqual(level === null ? [] : [expect.objectContaining({ level, subsystem: "runs", operation: "run_complete",
      duration_ms: heldMs, lock_wait_ms: 0, outcome: "committed" })]);
  });

  it("keeps a rolled-back waiter's lock wait with its unchanged error, through wrappers, and logs its failure kind", async () => {
    const failure = lockTimeout();
    const { tx } = fakeTx(2_000, () => failure);
    const observed: DbTransactionTiming[] = [];
    const pending = observeTransactionTimings(() => measureTransaction({ subsystem: "workspace", operation: "export_seal" },
      async (client: FakeTx) => {
        await sleep(40);
        await client.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${"chat"} FOR UPDATE`;
        return true;
      }, begin(tx)), (timing) => observed.push(timing));
    const settled = pending.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_040);
    const error = await settled;
    expect(error).toBe(failure);
    const timing = { duration_ms: 2_040, lock_wait_ms: 2_000, outcome: "rolled_back" };
    expect(transactionTimingOf(error)).toEqual(timing);
    expect(transactionTimingOf(new Error("wrapped", { cause: new Error("again", { cause: error }) }))).toEqual(timing);
    expect(transactionTimingOf(new Error("unrelated"))).toBeUndefined();
    expect(observed).toEqual([timing]);
    expect(transactionTimingFields(transactionTimingOf(error))).toEqual({ duration_ms: 2_040, lock_wait_ms: 2_000 });
    expect(transactionTimingFields(undefined)).toEqual({});
    expect(records()).toEqual([expect.objectContaining({ level: "warn", subsystem: "workspace", operation: "export_seal",
      duration_ms: 2_040, lock_wait_ms: 2_000, outcome: "rolled_back", db_failure: "lock_timeout" })]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("times nothing for a transaction that never started and passes its failure on unchanged", async () => {
    const failure = new Prisma.PrismaClientKnownRequestError("start", { clientVersion: "test", code: "P2028" });
    const observed: DbTransactionTiming[] = [];
    const work = vi.fn(async () => true);
    await expect(observeTransactionTimings(() => measureTransaction({ subsystem: "memory", operation: "deletion_commit" }, work,
      async () => { await Promise.resolve(); throw failure; }), (timing) => observed.push(timing))).rejects.toBe(failure);
    expect(work).not.toHaveBeenCalled();
    expect(observed).toEqual([]);
    expect(transactionTimingOf(failure)).toBeUndefined();
    expect(records()).toEqual([]);
  });

  it("hands other statements and client members through untouched", async () => {
    const lazy = { then: vi.fn() };
    const tx = { $executeRaw: vi.fn(() => lazy), model: { method: vi.fn(function (this: unknown) { return this; }) } };
    let seen: unknown;
    await measureTransaction({ subsystem: "runs", operation: "run_fail" }, async (client: typeof tx) => {
      // A non-lock statement keeps its own lazy promise; nothing awaited it here.
      expect(client.$executeRaw()).toBe(lazy);
      seen = client.model.method();
      return true;
    }, async (body) => body(tx));
    expect(lazy.then).not.toHaveBeenCalled();
    expect(seen).toBe(tx.model);
  });
});

describe("db_transaction record", () => {
  const operations = {
    job_commit: true, deletion_commit: true, export_claim: true, export_recovery_claim: true, export_reserve: true,
    export_seal: true, export_pending: true, export_complete: true, export_failed: true, export_renew: true,
    export_prepare_output: true, export_settle_output: true, run_complete: true, run_fail: true, run_cancel: true,
    usage_settlement: true
  } satisfies Record<DbTransactionOperation, true>;
  const jobKinds = {
    MEMORY_COMMAND: true, INDEX_HISTORY: true, EXTRACT_FACTS: true, CONSOLIDATE_CANDIDATE: true, VERIFY_CANDIDATE: true,
    EMBED_ITEMS: true, RECONCILE_BRANCH: true, RECONCILE_SOURCE: true, REBUILD_INDEX: true, RECLASSIFY_FACTS: true,
    RESOLVE_FACT_RELATIONS: true, SYNTHESIZE_MEMORIES: true
  } satisfies Record<DbTransactionJobKind, true>;
  const record = (fields: Record<string, unknown>) =>
    JSON.parse(serializeEvent("db_transaction", { subsystem: "memory", operation: "job_commit", duration_ms: 2_500,
      lock_wait_ms: 0, outcome: "committed", ...fields } as never)!) as Record<string, unknown>;

  it.each(Object.keys(operations))("keeps the operation %s", (operation) => {
    expect(record({ operation })).toMatchObject({ operation, level: "warn" });
  });

  it.each(Object.keys(jobKinds))("keeps the job kind %s", (job_kind) => {
    expect(record({ job_kind })).toMatchObject({ job_kind });
  });

  it("drops anything outside its closed fields", () => {
    const value = record({ subsystem: "PRIVATE", operation: "SELECT * FROM \"Chat\"", job_kind: "private", outcome: "maybe",
      db_failure: "PRIVATE", sql: "PRIVATE_SQL", chatId: "PRIVATE_CHAT" });
    expect(value).not.toHaveProperty("subsystem");
    expect(value).not.toHaveProperty("operation");
    expect(value).not.toHaveProperty("job_kind");
    expect(value).not.toHaveProperty("outcome");
    expect(value).not.toHaveProperty("db_failure");
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|SELECT/u);
    expect(record({ subsystem: "workspace", outcome: "rolled_back", db_failure: "lock_timeout" }))
      .toMatchObject({ subsystem: "workspace", outcome: "rolled_back", db_failure: "lock_timeout" });
  });

  it("is an error past the foreground budget, a warning past the slow bound and info below", () => {
    expect(record({ duration_ms: DB_TRANSACTION_FOREGROUND_BUDGET_MS + 1 }).level).toBe("error");
    expect(record({ duration_ms: DB_TRANSACTION_FOREGROUND_BUDGET_MS }).level).toBe("warn");
    expect(record({ duration_ms: DB_TRANSACTION_SLOW_MS + 1 }).level).toBe("warn");
    expect(record({ duration_ms: DB_TRANSACTION_SLOW_MS }).level).toBe("info");
    expect([DB_TRANSACTION_SLOW_MS, DB_TRANSACTION_FOREGROUND_BUDGET_MS]).toEqual([2_000, 5_000]);
  });

  it("adds a lock wait and duration to persistence and lifecycle records", () => {
    expect(JSON.parse(serializeEvent("run_persistence", { run_id: "run_1", stage: "complete", outcome: "confirmed",
      duration_ms: 812, lock_wait_ms: 790 })!)).toMatchObject({ duration_ms: 812, lock_wait_ms: 790 });
    expect(JSON.parse(serializeEvent("runtime_lifecycle", { subsystem: "workspace", stage: "export", outcome: "degraded",
      action: "retry", duration_ms: 2_031, lock_wait_ms: 2_004 })!)).toMatchObject({ duration_ms: 2_031, lock_wait_ms: 2_004 });
    expect(JSON.parse(serializeEvent("job_persistence", { subsystem: "memory", stage: "complete", outcome: "confirmed",
      duration_ms: 6_020, lock_wait_ms: 3 })!)).toMatchObject({ duration_ms: 6_020, lock_wait_ms: 3 });
  });
});
