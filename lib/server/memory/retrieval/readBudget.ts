import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS
} from "../../../domain/memory/retrieval/config";

export const MEMORY_READ_BUDGET_MS = Object.freeze({
  CANONICAL_REJOIN_EXPANSION: 1_100,
  LEXICAL_CANDIDATE: 1_050,
  PROJECTION_READINESS: 350,
  SNAPSHOT_CORE: 750,
  VECTOR_METADATA_REJOIN: 1_100
} as const);

export const MEMORY_READ_BUDGET_ERROR_CODES = [
  "memory_read_admission_timeout",
  "memory_read_connection_timeout",
  "memory_read_deadline_exhausted",
  "memory_read_lock_timeout",
  "memory_read_statement_timeout",
  "memory_read_transaction_expired"
] as const;

export type MemoryReadBudgetErrorCode =
  (typeof MEMORY_READ_BUDGET_ERROR_CODES)[number];

export class MemoryReadBudgetError extends Error {
  readonly code: MemoryReadBudgetErrorCode;

  constructor(code: MemoryReadBudgetErrorCode) {
    super(code);
    this.code = code;
    this.name = "MemoryReadBudgetError";
  }
}

const memoryReadBudgetErrorCodes = new Set<string>(MEMORY_READ_BUDGET_ERROR_CODES);

export function isMemoryReadBudgetErrorCode(
  value: unknown
): value is MemoryReadBudgetErrorCode {
  return typeof value === "string" && memoryReadBudgetErrorCodes.has(value);
}

/** Every read-budget failure except an already expired or closed interactive
 * transaction is a bounded wait or cancellation, not a lane defect. */
export function memoryReadBudgetTimedOut(code: MemoryReadBudgetErrorCode): boolean {
  return code !== "memory_read_transaction_expired";
}

type MemoryReadTransaction = Prisma.TransactionClient;

const MAX_MEMORY_READ_BUDGET_MS = 5_000;
const MEMORY_READ_LOCK_BUDGET_MS = 250;
const MEMORY_READ_MAX_WAIT_MS = 100;
const MEMORY_READ_TRANSACTION_GRACE_MS = 100;
// Prisma reports pool acquisition failure as P2028 with this fixed engine
// text. The text only selects the stable code and never leaves this module.
const connectionAcquisitionFailurePattern =
  /unable to start a transaction in the given time/iu;

function boundedBudget(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_MEMORY_READ_BUDGET_MS;
}

function prismaErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function prismaErrorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null || !("message" in error)) return "";
  return typeof error.message === "string" ? error.message : "";
}

function postgresErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("meta" in error) ||
    typeof error.meta !== "object" || error.meta === null || !("code" in error.meta)) {
    return null;
  }
  return typeof error.meta.code === "string" ? error.meta.code : null;
}

export function memoryReadBudgetFailureCode(
  error: unknown
): MemoryReadBudgetErrorCode | null {
  if (error instanceof MemoryReadBudgetError) return error.code;
  const postgresCode = postgresErrorCode(error);
  if (postgresCode === "55P03") return "memory_read_lock_timeout";
  if (postgresCode === "57014") return "memory_read_statement_timeout";
  // P2024: the pool itself timed out handing out a connection.
  if (prismaErrorCode(error) === "P2024") return "memory_read_connection_timeout";
  if (prismaErrorCode(error) === "P2028") {
    return connectionAcquisitionFailurePattern.test(prismaErrorMessage(error))
      ? "memory_read_connection_timeout"
      : "memory_read_transaction_expired";
  }
  return null;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/**
 * Admission class of one Memory read transaction. REQUIRED reads carry the
 * structure of an answer (snapshot, core/standing facts, entity alias probe,
 * canonical rejoin/expansion, profile and readiness reads); without them the
 * retrieval fails as a whole. LANE reads are optional candidate generation
 * (lane candidate and rejoin queries, vector lanes, rejection audit) whose
 * failure only degrades one lane. Every caller names its class explicitly.
 */
export type MemoryReadAdmissionClass = "LANE" | "REQUIRED";

type MemoryReadAdmission = Readonly<{
  acquire(options: Readonly<{
    admission: MemoryReadAdmissionClass;
    signal?: AbortSignal;
    waitMs: number;
  }>): Promise<() => void>;
}>;

/** Process-local permits with one queue per class, FIFO within a class. A
 * released permit passes directly to the oldest REQUIRED waiter, otherwise to
 * the oldest LANE waiter; an aborted or timed-out waiter leaves its queue
 * without dispatch. LANE reads proceed whenever no REQUIRED read waits. */
function createMemoryReadAdmission(limit: number): MemoryReadAdmission {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("memory_read_admission_invalid");
  }
  let active = 0;
  const queues: Readonly<Record<MemoryReadAdmissionClass, Array<() => void>>> = {
    LANE: [],
    REQUIRED: []
  };
  const permit = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queues.REQUIRED.shift() ?? queues.LANE.shift();
      if (next) next();
      else active -= 1;
    };
  };
  return Object.freeze({
    acquire({ admission, signal, waitMs }) {
      const waiters = queues[admission];
      if (!waiters) return Promise.reject(new Error("memory_read_admission_invalid"));
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (active < limit && queues.REQUIRED.length === 0 &&
        (admission === "REQUIRED" || queues.LANE.length === 0)) {
        active += 1;
        return Promise.resolve(permit());
      }
      if (!Number.isSafeInteger(waitMs) || waitMs < 1) {
        return Promise.reject(new MemoryReadBudgetError("memory_read_admission_timeout"));
      }
      return new Promise<() => void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const grant = () => {
          cleanup();
          resolve(permit());
        };
        const withdraw = () => {
          const index = waiters.indexOf(grant);
          if (index >= 0) waiters.splice(index, 1);
          cleanup();
        };
        const onAbort = () => {
          withdraw();
          reject(abortReason(signal!));
        };
        timer = setTimeout(() => {
          withdraw();
          reject(new MemoryReadBudgetError("memory_read_admission_timeout"));
        }, waitMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(grant);
      });
    }
  });
}

const memoryReadAdmission = createMemoryReadAdmission(
  MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS
);
// Marks the dynamic extent of one admitted transaction. A nested admission
// would wait for a permit its own caller holds.
const admittedMemoryRead = new AsyncLocalStorage<true>();

/**
 * Bounds PostgreSQL resource lifetime independently from the caller's
 * response-settlement signal. Each call is the only process-wide admission
 * point for one Memory read transaction: the permit is taken before a pooled
 * connection is requested and is released only after the transaction has
 * ended. The signal and deadline withdraw a waiting read before dispatch; they
 * never cancel started SQL, which the server-side statement timeout bounds.
 * Synchronous Memory reads deliberately do not retry after a database timeout.
 */
export async function withMemoryReadBudget<T>(
  client: Pick<PrismaClient, "$transaction">,
  budgetMs: number,
  work: (tx: MemoryReadTransaction) => Promise<T>,
  options: Readonly<{
    /** Required, never defaulted: a misclassified read changes who waits. */
    admission: MemoryReadAdmissionClass;
    deadlineAtMs?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
    lockBudgetMs?: number;
    preserveExplicitJoinOrder?: boolean;
    signal?: AbortSignal;
  }>
): Promise<T> {
  const lockBudgetMs = options.lockBudgetMs ?? Math.min(
    MEMORY_READ_LOCK_BUDGET_MS,
    budgetMs
  );
  if (!boundedBudget(budgetMs) || !boundedBudget(lockBudgetMs) ||
    lockBudgetMs > budgetMs ||
    (options.admission !== "LANE" && options.admission !== "REQUIRED") ||
    options.deadlineAtMs !== undefined &&
      (!Number.isSafeInteger(options.deadlineAtMs) || options.deadlineAtMs < 1) ||
    options.preserveExplicitJoinOrder !== undefined &&
      typeof options.preserveExplicitJoinOrder !== "boolean") {
    throw new Error("memory_read_budget_invalid");
  }
  if (admittedMemoryRead.getStore()) throw new Error("memory_read_admission_nested");
  const remainingMs = () => options.deadlineAtMs === undefined
    ? budgetMs
    : Math.min(budgetMs, options.deadlineAtMs - Date.now());
  if (options.signal?.aborted) throw abortReason(options.signal);
  if (remainingMs() < 1) throw new MemoryReadBudgetError("memory_read_deadline_exhausted");
  const release = await memoryReadAdmission.acquire({
    admission: options.admission,
    signal: options.signal,
    waitMs: remainingMs()
  });
  try {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const statementBudgetMs = remainingMs();
    if (statementBudgetMs < 1) {
      throw new MemoryReadBudgetError("memory_read_deadline_exhausted");
    }
    const statementTimeout = `${statementBudgetMs}ms`;
    const lockTimeout = `${Math.min(lockBudgetMs, statementBudgetMs)}ms`;
    try {
      return await admittedMemoryRead.run(true, () => client.$transaction(async (tx) => {
        // The Prisma query engine does not apply PGOPTIONS, so JIT stays on
        // for the pool. Short authority-heavy reads must not pay LLVM
        // compilation inside their budget; the setting ends with the transaction.
        await tx.$queryRaw(Prisma.sql`
          SELECT
            set_config('lock_timeout', ${lockTimeout}, true),
            set_config('statement_timeout', ${statementTimeout}, true),
            set_config('jit', 'off', true)
            ${options.preserveExplicitJoinOrder
              ? Prisma.sql`, set_config('join_collapse_limit', '1', true)`
              : Prisma.sql``}
        `);
        return work(tx);
      }, {
        isolationLevel: options.isolationLevel ??
          Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: MEMORY_READ_MAX_WAIT_MS,
        timeout: statementBudgetMs + MEMORY_READ_TRANSACTION_GRACE_MS
      }));
    } catch (error) {
      const code = memoryReadBudgetFailureCode(error);
      if (code) throw new MemoryReadBudgetError(code);
      throw error;
    }
  } finally {
    release();
  }
}
