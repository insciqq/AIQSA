import { Prisma, type PrismaClient } from "@prisma/client";
import { estimateCostMicros, sumEstimatedCostMicros, type ModelTokenPricing } from "../../domain/usage";
import { logEvent } from "../observability";

type FrozenPrice = ModelTokenPricing & { id: string; modelId: string; provider: string };
export type CatalogCostBatchOptions = Readonly<{ size?: number; skipTransient?: boolean }>;
export type CatalogCostBatchResult = Readonly<{ more: boolean; skipped: number; completed: boolean }>;

const BATCH_SIZE = 250;
const INT32_MAX = 2_147_483_647;
// Contention and deadlines, not a property of the row: retried before any skip.
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "55P03", "57014"]);
// Bounded in-process retry: 1+5+20+60 s. Each retry shrinks the batch four-fold,
// so the last attempt holds one row and a persistent failure is skipped.
const RETRY_DELAYS_MS = [1_000, 5_000, 20_000, 60_000] as const;
const PAUSE_MS = 25;

function sqlState(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (error.code === "P2034") return "40001";
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return error.code === "P2010" && typeof code === "string" ? code : null;
}

class TransientRowFailure extends Error {
  constructor(cause: unknown) { super("catalog_cost_backfill_row_transient", { cause }); }
}

function prismaCode(error: unknown): string | undefined {
  const source = error instanceof TransientRowFailure ? error.cause : error;
  return source instanceof Prisma.PrismaClientKnownRequestError ? source.code : undefined;
}

/** Chat-summary receipts have always stored the exact ProviderModel id in
 * `modelId` (and the provider family in `provider`), never `providerModelId`. */
function receiptProviderModelId(row: { id: string; modelId: string; providerModelId: string | null }): string | null {
  return row.providerModelId ?? (row.id.startsWith("chat-summary:") ? row.modelId : null);
}

function findPrice(prices: FrozenPrice[], row: { provider: string; modelId: string }, providerModelId?: string | null) {
  const matches = prices.filter(price => providerModelId ? price.id === providerModelId
    : price.provider === row.provider && price.modelId === row.modelId);
  return matches.length === 1 ? matches[0] : null;
}

/** One row per savepoint. A rejection (guard, deferred constraint, range) rolls
 * back only that row; a lost connection or closed transaction fails the savepoint
 * rollback and aborts the batch. Contention aborts the batch for a retry unless
 * this is the last attempt. */
async function isolatedUpdate(tx: Prisma.TransactionClient, update: () => Promise<unknown>, skipTransient: boolean) {
  await tx.$executeRawUnsafe("SAVEPOINT catalog_cost_row");
  try {
    await update();
  } catch (error) {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT catalog_cost_row");
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT catalog_cost_row");
    const state = sqlState(error);
    if (!skipTransient && state !== null && TRANSIENT_SQLSTATES.has(state)) throw new TransientRowFailure(error);
    return false;
  }
  await tx.$executeRawUnsafe("RELEASE SAVEPOINT catalog_cost_row");
  return true;
}

/** Commits at most `size` rows and one cursor. Exact stored prices were frozen by the
 * upgrade; later administrative changes cannot alter this historical adoption.
 * The cursor always moves past every selected row, including skipped ones. */
export async function backfillCatalogCostBatch(db: PrismaClient, id = "20260930",
  options: CatalogCostBatchOptions = {}): Promise<CatalogCostBatchResult> {
  const size = Math.max(1, Math.min(BATCH_SIZE, Math.floor(options.size ?? BATCH_SIZE)));
  const skipTransient = options.skipTransient ?? false;
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "CatalogCostBackfill" WHERE id = ${id} FOR UPDATE`;
    const state = await tx.catalogCostBackfill.findUnique({ where: { id } });
    if (!state || state.completedAt) return { more: false, skipped: 0, completed: false };
    const prices = state.prices as unknown as FrozenPrice[];
    // Deferred constraint triggers must reject the offending statement inside its
    // savepoint instead of the whole commit.
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    const bound = () => tx.$queryRawUnsafe(
      "SELECT set_config('lock_timeout', '5s', true), set_config('statement_timeout', '10s', true)");
    let skipped = 0;
    const apply = async (update: () => Promise<unknown>) => {
      if (!await isolatedUpdate(tx, update, skipTransient)) skipped += 1;
    };
    if (!state.usageFinished) {
      const rows = await tx.usageEvent.findMany({
        where: { createdAt: { lte: state.cutoffAt }, ...(state.usageCursor ? { id: { gt: state.usageCursor } } : {}),
          estimatedCostMicros: null, usageCompleteness: "COMPLETE", imageGeneration: false, optionalDecision: false,
          // Memory settlement compares the receipt with its binding's own snapshot.
          memoryExecutionBindingId: null },
        orderBy: { id: "asc" }, take: size,
        select: { id: true, provider: true, modelId: true, providerModelId: true, inputTokens: true, cachedInputTokens: true,
          cacheWriteInputTokens: true, outputTokens: true, reasoningTokens: true, totalTokens: true }
      });
      await bound();
      for (const row of rows) {
        const price = findPrice(prices, row, receiptProviderModelId(row));
        const cost = price ? estimateCostMicros({ ...row, completeness: "complete" }, price) : null;
        if (cost !== null) await apply(() => tx.$executeRaw`UPDATE "UsageEvent" SET "estimatedCostMicros" = ${cost}
          WHERE id = ${row.id} AND "estimatedCostMicros" IS NULL`);
      }
      await tx.catalogCostBackfill.update({ where: { id }, data: {
        ...(rows.length ? { usageCursor: rows[rows.length - 1]!.id } : {}), usageFinished: rows.length < size
      } });
      return { more: true, skipped, completed: false };
    }
    // The receipt lookup uses UsageEvent_modelRunId_idx, one bounded probe per batch.
    const runs = await tx.modelRun.findMany({
      where: { createdAt: { lte: state.cutoffAt }, ...(state.runCursor ? { id: { gt: state.runCursor } } : {}),
        estimatedCostMicros: null, usageCompleteness: "COMPLETE", status: { in: ["complete", "error", "cancelled"] } },
      orderBy: { id: "asc" }, take: size,
      select: {
        id: true, provider: true, modelId: true, inputTokens: true, cachedInputTokens: true, cacheWriteInputTokens: true,
        outputTokens: true, reasoningTokens: true, totalTokens: true,
        providerRunBindings: { where: { bindingKey: "answer" }, select: { providerModelId: true } },
        usageEvents: { where: { chatPdfPreparation: false, imageGeneration: false, chatTitleGeneration: false,
          visionAnalysis: false, knowledgeRelevance: false, optionalDecision: false }, select: { estimatedCostMicros: true } }
      }
    });
    await bound();
    for (const run of runs) {
      const price = findPrice(prices, run, run.providerRunBindings[0]?.providerModelId);
      if (!price) continue;
      const cost = run.usageEvents.length ? sumEstimatedCostMicros(run.usageEvents.map(event => event.estimatedCostMicros))
        : estimateCostMicros({ ...run, completeness: "complete" }, price);
      // Raw SQL leaves the @updatedAt column alone: it ends the displayed work
      // duration of a terminal run without answer text.
      if (cost !== null && cost <= INT32_MAX) await apply(() => tx.$executeRaw`UPDATE "ModelRun" SET "estimatedCostMicros" = ${cost}
        WHERE id = ${run.id} AND "estimatedCostMicros" IS NULL`);
    }
    const completed = runs.length < size;
    await tx.catalogCostBackfill.update({ where: { id }, data: {
      ...(runs.length ? { runCursor: runs[runs.length - 1]!.id } : {}),
      ...(completed ? { completedAt: new Date(), prices: [] as Prisma.InputJsonValue } : {})
    } });
    return { more: !completed, skipped, completed };
  }, { timeout: 30_000 });
}

/** Runs the backfill to completion in this process. Only an outage that outlasts
 * the bounded retries stops it; the next start resumes the committed cursor. */
export async function runCatalogCostBackfill(db: PrismaClient, dependencies: Readonly<{
  id?: string; sleep?: (ms: number) => Promise<void>;
}> = {}): Promise<void> {
  const sleep = dependencies.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let failures = 0;
  for (;;) {
    const lastAttempt = failures === RETRY_DELAYS_MS.length;
    let result: CatalogCostBatchResult;
    try {
      result = await backfillCatalogCostBatch(db, dependencies.id, {
        size: BATCH_SIZE >> (2 * failures), skipTransient: lastAttempt
      });
    } catch (error) {
      const delay = RETRY_DELAYS_MS[failures];
      logEvent("service_operation", { error, subsystem: "database", stage: "startup", outcome: lastAttempt ? "degraded" : "failed",
        action: lastAttempt ? "stop" : "retry", code: "catalog_cost_backfill_failed", attempt: failures + 1,
        prisma_code: prismaCode(error), ...(delay === undefined ? {} : { delay_ms: delay }) });
      if (delay === undefined) return;
      await sleep(delay);
      failures += 1;
      continue;
    }
    failures = 0;
    if (result.skipped) logEvent("service_operation", { subsystem: "database", stage: "startup", outcome: "skipped",
      action: "skip", code: "catalog_cost_backfill_row_skipped", count: result.skipped });
    if (result.completed) logEvent("service_operation", { subsystem: "database", stage: "startup", outcome: "completed" });
    if (!result.more) return;
    await sleep(PAUSE_MS);
  }
}

let running: Promise<void> | undefined;
export function startCatalogCostBackfill(): void {
  // Never replays providers: it only prices persisted, provider-reported usage.
  running ??= import("../prisma").then(({ prisma }) => runCatalogCostBackfill(prisma)).catch((error: unknown) => {
    logEvent("service_operation", { error, subsystem: "database", stage: "startup", outcome: "degraded", code: "catalog_cost_backfill_failed" });
  });
}
