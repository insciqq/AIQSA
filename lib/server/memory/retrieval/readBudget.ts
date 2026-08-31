import { Prisma, type PrismaClient } from "@prisma/client";

export const MEMORY_READ_BUDGET_MS = Object.freeze({
  CANONICAL_REJOIN_EXPANSION: 1_100,
  LEXICAL_CANDIDATE: 1_050,
  PROJECTION_READINESS: 350,
  SNAPSHOT_CORE: 750,
  VECTOR_METADATA_REJOIN: 1_100
} as const);

export const MEMORY_READ_BUDGET_ERROR_CODES = [
  "memory_read_lock_timeout",
  "memory_read_statement_timeout"
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

type MemoryReadTransaction = Prisma.TransactionClient;

const MAX_MEMORY_READ_BUDGET_MS = 5_000;
const MEMORY_READ_LOCK_BUDGET_MS = 250;
const MEMORY_READ_MAX_WAIT_MS = 100;
const MEMORY_READ_TRANSACTION_GRACE_MS = 100;

function boundedBudget(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_MEMORY_READ_BUDGET_MS;
}

function prismaErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
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
  const postgresCode = postgresErrorCode(error);
  if (postgresCode === "55P03") return "memory_read_lock_timeout";
  if (postgresCode === "57014" || prismaErrorCode(error) === "P2028") {
    return "memory_read_statement_timeout";
  }
  return null;
}

/**
 * Bounds PostgreSQL resource lifetime independently from the caller's
 * response-settlement signal. Synchronous Memory reads deliberately do not
 * retry after a database timeout.
 */
export async function withMemoryReadBudget<T>(
  client: Pick<PrismaClient, "$transaction">,
  budgetMs: number,
  work: (tx: MemoryReadTransaction) => Promise<T>,
  options: Readonly<{
    isolationLevel?: Prisma.TransactionIsolationLevel;
    lockBudgetMs?: number;
    preserveExplicitJoinOrder?: boolean;
  }> = {}
): Promise<T> {
  const lockBudgetMs = options.lockBudgetMs ?? Math.min(
    MEMORY_READ_LOCK_BUDGET_MS,
    budgetMs
  );
  if (!boundedBudget(budgetMs) || !boundedBudget(lockBudgetMs) ||
    lockBudgetMs > budgetMs ||
    options.preserveExplicitJoinOrder !== undefined &&
      typeof options.preserveExplicitJoinOrder !== "boolean") {
    throw new Error("memory_read_budget_invalid");
  }
  const statementTimeout = `${budgetMs}ms`;
  const lockTimeout = `${lockBudgetMs}ms`;
  const transactionTimeout = budgetMs + MEMORY_READ_TRANSACTION_GRACE_MS;
  try {
    return await client.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT
          set_config('lock_timeout', ${lockTimeout}, true),
          set_config('statement_timeout', ${statementTimeout}, true)
          ${options.preserveExplicitJoinOrder
            ? Prisma.sql`, set_config('join_collapse_limit', '1', true)`
            : Prisma.sql``}
      `);
      return work(tx);
    }, {
      isolationLevel: options.isolationLevel ??
        Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: MEMORY_READ_MAX_WAIT_MS,
      timeout: transactionTimeout
    });
  } catch (error) {
    const code = memoryReadBudgetFailureCode(error);
    if (code) throw new MemoryReadBudgetError(code);
    throw error;
  }
}
