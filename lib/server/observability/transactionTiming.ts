import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { databaseFailureKind } from "./databaseFailure";
import type { DbTransactionJobKind, DbTransactionOperation, DbTransactionSubsystem } from "./events";
import { DB_TRANSACTION_FOREGROUND_BUDGET_MS, DB_TRANSACTION_SLOW_MS, logEvent } from "./runtime.cjs";

export { DB_TRANSACTION_FOREGROUND_BUDGET_MS, DB_TRANSACTION_SLOW_MS };

/**
 * Timing of the interactive transactions on the hot paths: Memory commits,
 * Workspace export steps, run terminal writes. Without PostgreSQL logs, the
 * holder of a contended row reports how long it held its rows and a waiter how
 * long it waited for them.
 *
 * `duration_ms` runs from the transaction's start (its callback) until it
 * committed or rolled back; `lock_wait_ms` is the part spent in the
 * transaction's explicit lock statements (`FOR UPDATE`/`FOR SHARE` reads,
 * `LOCK TABLE`, advisory locks), measured around each such query whether it
 * returned or failed. Ordinary writes that wait on a row lock are not counted.
 * Measuring never changes what the transaction runs or returns.
 */

export type DbTransactionDescriptor = Readonly<{
  subsystem: DbTransactionSubsystem;
  operation: DbTransactionOperation;
  job_kind?: DbTransactionJobKind;
}>;

export type DbTransactionTiming = Readonly<{
  duration_ms: number;
  lock_wait_ms: number;
  outcome: "committed" | "rolled_back";
}>;

const RAW_METHODS: ReadonlySet<PropertyKey> = new Set(["$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"]);
const LOCK_STATEMENT = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b|\bLOCK\s+TABLE\b|\bpg_advisory(?:_xact)?_lock/iu;
const MAX_CAUSE_DEPTH = 8;
// Monotonic, and read at call time so a test's fake clock applies.
const now = (): number => globalThis.performance.now();
const failedTimings = new WeakMap<object, DbTransactionTiming>();
const observers = new AsyncLocalStorage<(timing: DbTransactionTiming) => void>();

/** The SQL text of a raw query call: a template, a `Prisma.sql` value or an unsafe string. */
function statementText(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (Array.isArray(first)) return first.join(" ");
  if (first !== null && typeof first === "object") {
    const strings = (first as { strings?: unknown }).strings;
    if (Array.isArray(strings)) return strings.join(" ");
  }
  return "";
}

/** True for a statement that requests a row, table or advisory lock. */
export function isLockStatement(text: string): boolean {
  return LOCK_STATEMENT.test(text);
}

/**
 * The transaction client as its work sees it: identical, except that a raw
 * lock statement adds its time to `onLock`. Every other access is the client's own.
 */
function timedClient<Tx extends object>(tx: Tx, onLock: (milliseconds: number) => void): Tx {
  return new Proxy(tx, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function" || !RAW_METHODS.has(property)) return value;
      return (...args: unknown[]): unknown => {
        if (!isLockStatement(statementText(args))) return Reflect.apply(value, target, args);
        const started = now();
        return Promise.resolve(Reflect.apply(value, target, args) as unknown)
          .finally(() => onLock(now() - started));
      };
    }
  });
}

function report(descriptor: DbTransactionDescriptor, timing: DbTransactionTiming, error: unknown): void {
  try {
    observers.getStore()?.(timing);
  } catch { /* An observer never changes the transaction's result. */ }
  if (timing.duration_ms <= DB_TRANSACTION_SLOW_MS) return;
  logEvent("db_transaction", {
    subsystem: descriptor.subsystem, operation: descriptor.operation, job_kind: descriptor.job_kind,
    duration_ms: timing.duration_ms, lock_wait_ms: timing.lock_wait_ms, outcome: timing.outcome,
    db_failure: timing.outcome === "rolled_back" ? databaseFailureKind(error) : undefined
  });
}

/**
 * Runs `work` in the interactive transaction `begin` opens and times it.
 * `begin` receives the body to hand to `$transaction` with its own options;
 * the body gives `work` the transaction client, timed for lock statements.
 * The result or failure is returned unchanged; a failed transaction's timing
 * stays with its error (`transactionTimingOf`).
 */
export async function measureTransaction<R, Tx extends object = Prisma.TransactionClient>(
  descriptor: DbTransactionDescriptor,
  work: (tx: Tx) => Promise<R>,
  begin: (body: (tx: Tx) => Promise<R>) => PromiseLike<R>
): Promise<R> {
  let started: number | undefined;
  let lockWait = 0;
  const settle = (outcome: DbTransactionTiming["outcome"], error?: unknown): DbTransactionTiming | undefined => {
    // A transaction that never started held nothing.
    if (started === undefined) return undefined;
    try {
      const duration = Math.max(0, now() - started);
      const timing: DbTransactionTiming = Object.freeze({
        duration_ms: Math.round(duration), lock_wait_ms: Math.round(Math.min(lockWait, duration)), outcome
      });
      report(descriptor, timing, error);
      return timing;
    } catch {
      return undefined;
    }
  };
  try {
    const result = await begin((tx) => {
      started ??= now();
      return work(timedClient(tx, (milliseconds) => { lockWait += milliseconds; }));
    });
    settle("committed");
    return result;
  } catch (error) {
    const timing = settle("rolled_back", error);
    if (timing !== undefined && error !== null && typeof error === "object") failedTimings.set(error, timing);
    throw error;
  }
}

/** Runs `work`; every timed transaction it settles reports its timing to `onTiming`. */
export function observeTransactionTimings<T>(work: () => Promise<T>, onTiming: (timing: DbTransactionTiming) => void): Promise<T> {
  return observers.run(onTiming, work);
}

/** The timing of the failed transaction behind `error`, along its cause chain. */
export function transactionTimingOf(error: unknown): DbTransactionTiming | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null && typeof current === "object"; depth += 1) {
    const timing = failedTimings.get(current);
    if (timing !== undefined) return timing;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A timing as the fields of a persistence or lifecycle record; none without one. */
export function transactionTimingFields(timing: DbTransactionTiming | undefined): Readonly<{
  duration_ms?: number; lock_wait_ms?: number;
}> {
  return timing === undefined ? {} : { duration_ms: timing.duration_ms, lock_wait_ms: timing.lock_wait_ms };
}
