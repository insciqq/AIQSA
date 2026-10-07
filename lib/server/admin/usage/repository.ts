import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ADMIN_USAGE_CATEGORIES,
  type AdminUsageAmounts,
  type AdminUsageAnalytics,
  type AdminUsageCategory,
  type AdminUsagePeriod
} from "@/lib/contracts/adminUsageAnalytics";
import {
  PERSONAL_USAGE_PURPOSES,
  isUsagePurpose,
  type PersonalUsagePurpose,
  type UsagePurpose
} from "@/lib/domain/usagePurpose";
import {
  serializeAdminUsageAnalytics,
  type UsageAggregateRow,
  type UsageAggregateSet,
  type UsageComparisonTotals,
  type UsageScope,
  type UsageUserSource
} from "./analytics";
import { MAX_USAGE_EXPORT_ROWS, type UsageExportRow } from "./csv";
import { createUsageModelResolver, type ResolvedUsageModel, type UsageCatalogModel } from "./models";
import { planUsageWindow, type UsageWindowPlan } from "./window";

/**
 * Period aggregation over persisted `UsageEvent` rows. Every read of one
 * response shares a repeatable-read snapshot, so totals, breakdowns, the
 * resolved model keys and the user list describe the same rows.
 */

export type UsageReadInput = Readonly<{ now: Date; period: AdminUsagePeriod; timeZone: string }>;

export type UsageExport = Readonly<{
  models: ReadonlyMap<string, ResolvedUsageModel>;
  plan: UsageWindowPlan;
  rows: readonly UsageExportRow[];
  users: ReadonlyMap<string, UsageUserSource>;
}>;

export type AdminUsageRepository = Readonly<{
  readAnalytics(input: UsageReadInput): Promise<AdminUsageAnalytics>;
  /** `null` when the export would exceed {@link MAX_USAGE_EXPORT_ROWS} rows. */
  readExport(input: UsageReadInput): Promise<UsageExport | null>;
}>;

/** PostgreSQL rejected a zone the runtime accepted. */
export class UsageTimeZoneUnsupportedError extends Error {
  constructor() { super("usage_time_zone_unsupported"); }
}

type Tx = Prisma.TransactionClient;
type Range = Readonly<{ from: Date; to: Date }>;
type KeyRow = Readonly<{ canonical: string; modelId: string; provider: string; providerModelId: string }>;

const TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  maxWait: 10_000,
  timeout: 120_000
} as const;

type GroupingColumn = "bucket" | "category" | "model" | "purpose" | "scope" | "userId";

const GROUPING_COLUMNS: readonly GroupingColumn[] = ["bucket", "category", "model", "userId", "purpose", "scope"];

/** Every aggregate slice of one window and the `base` columns it groups by. */
const AGGREGATE_SETS: ReadonlyArray<readonly [UsageAggregateSet, readonly GroupingColumn[]]> = [
  ["total", []],
  ["bucket", ["bucket"]],
  ["bucket_category", ["bucket", "category"]],
  ["category", ["category"]],
  ["purpose", ["purpose"]],
  ["purpose_model", ["purpose", "model"]],
  ["scope_model", ["scope", "model"]],
  ["user", ["userId"]],
  ["user_scope", ["userId", "scope"]],
  ["user_scope_model", ["userId", "scope", "model"]]
];

/** `GROUPING(...)` sets a bit for every column a set aggregates away; the last column is the lowest bit. */
function groupingMask(columns: readonly GroupingColumn[]): number {
  return GROUPING_COLUMNS.reduce((mask, column) => mask * 2 + (columns.includes(column) ? 0 : 1), 0);
}

const SET_BY_GROUPING: ReadonlyMap<number, UsageAggregateSet> = new Map(
  AGGREGATE_SETS.map(([set, columns]) => [groupingMask(columns), set])
);

// Identifiers come only from the constant lists above.
const quoted = (columns: readonly GroupingColumn[]) => columns.map((column) => `"${column}"`).join(", ");
const GROUPING_SELECT = Prisma.raw(`GROUPING(${quoted(GROUPING_COLUMNS)})::int AS "grouping", ${quoted(GROUPING_COLUMNS)}`);
const GROUPING_SETS = Prisma.raw(`GROUPING SETS (${AGGREGATE_SETS.map(([, columns]) => `(${quoted(columns)})`).join(", ")})`);

const IMAGE_PURPOSE = "image_generation" satisfies PersonalUsagePurpose;
const PERSONAL = Prisma.sql`ue."purpose" IN (${Prisma.join(PERSONAL_USAGE_PURPOSES.map((value) =>
  Prisma.sql`${value}::"UsagePurpose"`))})`;

/**
 * Categories derive from the purpose when read. Personal usage of a scheduled
 * run reads as `scheduled` while the run is retained; after a deletion
 * detaches the run it reads as `chat`.
 */
const CATEGORY = Prisma.sql`CASE
  WHEN NOT (${PERSONAL}) THEN 'system'
  WHEN ue."purpose" = ${IMAGE_PURPOSE}::"UsagePurpose" THEN 'images'
  WHEN mr."scheduledTaskId" IS NOT NULL THEN 'scheduled'
  ELSE 'chat' END`;

const SCOPE = Prisma.sql`CASE WHEN ${PERSONAL} THEN 'personal' ELSE 'system' END`;

const AMOUNTS = Prisma.sql`
  COUNT(*) AS "recordCount",
  COUNT("estimatedCostMicros") AS "knownCostRecordCount",
  SUM("estimatedCostMicros") AS "estimatedCostMicros",
  SUM("inputTokens") AS "inputTokens",
  SUM("cachedInputTokens") AS "cachedInputTokens",
  SUM("cacheWriteInputTokens") AS "cacheWriteInputTokens",
  SUM("outputTokens") AS "outputTokens",
  SUM("reasoningTokens") AS "reasoningTokens",
  SUM("totalTokens") AS "totalTokens",
  COUNT(*) FILTER (WHERE "incomplete") AS "incompleteUsageCount",
  COUNT(DISTINCT "modelRunId") AS "runCount"`;

function inRange(range: Range): Prisma.Sql {
  return Prisma.sql`ue."createdAt" >= (${range.from}::timestamptz AT TIME ZONE 'UTC')
    AND ue."createdAt" < (${range.to}::timestamptz AT TIME ZONE 'UTC')`;
}

/** The `keys` and `base` CTEs: one row per usage record with its purpose, scope, category, local bucket and canonical model. */
function baseRows(plan: UsageWindowPlan & { from: Date }, keys: readonly KeyRow[]): Prisma.Sql {
  const unit = plan.bucket === "month" ? "month" : "day";
  const format = plan.bucket === "month" ? "YYYY-MM" : "YYYY-MM-DD";
  return Prisma.sql`
    keys AS (
      SELECT * FROM unnest(${keys.map((key) => key.provider)}::text[], ${keys.map((key) => key.modelId)}::text[],
        ${keys.map((key) => key.providerModelId)}::text[], ${keys.map((key) => key.canonical)}::text[])
        AS k("provider", "modelId", "providerModelId", "canonical")
    ),
    base AS (
      SELECT ue."userId", ue."modelRunId", ue."createdAt", ue."estimatedCostMicros", ue."inputTokens",
        ue."cachedInputTokens", ue."cacheWriteInputTokens", ue."outputTokens", ue."reasoningTokens", ue."totalTokens",
        ue."usageCompleteness" <> 'COMPLETE' AS "incomplete",
        ue."purpose"::text AS "purpose",
        ${SCOPE} AS "scope",
        ${CATEGORY} AS "category",
        to_char(date_trunc(${unit}::text, (ue."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${plan.timeZone}::text),
          ${format}::text) AS "bucket",
        COALESCE(k."canonical", 'raw' || chr(31) || ue."provider" || chr(31) || ue."modelId") AS "model"
      FROM "UsageEvent" ue
      LEFT JOIN "ModelRun" mr ON mr."id" = ue."modelRunId"
      LEFT JOIN keys k ON k."provider" = ue."provider" AND k."modelId" = ue."modelId"
        AND k."providerModelId" = COALESCE(ue."providerModelId", '')
      WHERE ${inRange(plan)}
    )`;
}

function count(value: unknown): number {
  const result = nullableCount(value);
  return result ?? 0;
}

/** Sums arrive as BigInt (or numeric text); only safe non-negative integers reach the contract. */
function nullableCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "bigint" ? value : typeof value === "number" || typeof value === "string" ? BigInt(value) : null;
  if (parsed === null || parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("usage_amount_out_of_range");
  return Number(parsed);
}

function instant(value: unknown): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function amountsOf(row: Record<string, unknown>): AdminUsageAmounts {
  return {
    cachedInputTokens: nullableCount(row.cachedInputTokens),
    cacheWriteInputTokens: nullableCount(row.cacheWriteInputTokens),
    estimatedCostMicros: nullableCount(row.estimatedCostMicros),
    incompleteUsageCount: count(row.incompleteUsageCount),
    inputTokens: nullableCount(row.inputTokens),
    knownCostRecordCount: count(row.knownCostRecordCount),
    outputTokens: nullableCount(row.outputTokens),
    reasoningTokens: nullableCount(row.reasoningTokens),
    recordCount: count(row.recordCount),
    runCount: count(row.runCount),
    totalTokens: nullableCount(row.totalTokens)
  };
}

function category(value: unknown): AdminUsageCategory {
  if (!(ADMIN_USAGE_CATEGORIES as readonly unknown[]).includes(value)) throw new Error("usage_category_invalid");
  return value as AdminUsageCategory;
}

function purpose(value: unknown): UsagePurpose {
  if (!isUsagePurpose(value)) throw new Error("usage_purpose_invalid");
  return value;
}

function scope(value: unknown): UsageScope {
  if (value !== "personal" && value !== "system") throw new Error("usage_scope_invalid");
  return value;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function earliestUsageAt(tx: Tx): Promise<Date | null> {
  const [row] = await tx.$queryRaw<Array<{ earliest: unknown }>>`
    SELECT MIN("createdAt") AT TIME ZONE 'UTC' AS "earliest" FROM "UsageEvent"`;
  return instant(row?.earliest);
}

function upstreamModelIds(modelId: string, activeConfig: Prisma.JsonValue | null): string[] {
  const configured = activeConfig && typeof activeConfig === "object" && !Array.isArray(activeConfig)
    ? activeConfig.upstreamModelId : undefined;
  return typeof configured === "string" && configured.trim() && configured !== modelId ? [modelId, configured] : [modelId];
}

/** Resolves every raw model identity in the window once, in JavaScript, and hands the mapping back to SQL. */
async function resolveModelKeys(tx: Tx, range: Range): Promise<Readonly<{ keys: KeyRow[]; models: Map<string, ResolvedUsageModel> }>> {
  const raw = await tx.$queryRaw<Array<{ modelId: string; provider: string; providerModelId: string }>>`
    SELECT DISTINCT ue."provider", ue."modelId", COALESCE(ue."providerModelId", '') AS "providerModelId"
    FROM "UsageEvent" ue WHERE ${inRange(range)}`;
  if (raw.length === 0) return { keys: [], models: new Map() };
  const catalog = await tx.providerModel.findMany({
    select: {
      activeConfig: true, connectionId: true, displayName: true, id: true, modelId: true,
      connection: { select: { displayName: true, family: true } }
    }
  });
  const resolve = createUsageModelResolver(catalog.map((model): UsageCatalogModel => ({
    connectionDisplayName: model.connection.displayName,
    connectionId: model.connectionId,
    displayName: model.displayName,
    family: model.connection.family,
    id: model.id,
    upstreamModelIds: upstreamModelIds(model.modelId, model.activeConfig)
  })));
  const models = new Map<string, ResolvedUsageModel>();
  const keys = raw.map((row): KeyRow => {
    const resolved = resolve({ modelId: row.modelId, provider: row.provider, providerModelId: row.providerModelId || null });
    models.set(resolved.key, resolved);
    return { canonical: resolved.key, modelId: row.modelId, provider: row.provider, providerModelId: row.providerModelId };
  });
  return { keys, models };
}

async function aggregateRows(tx: Tx, plan: UsageWindowPlan & { from: Date }, keys: readonly KeyRow[]): Promise<UsageAggregateRow[]> {
  const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
    WITH ${baseRows(plan, keys)}
    SELECT ${GROUPING_SELECT}, ${AMOUNTS},
      COUNT(DISTINCT "userId") AS "userCount",
      MAX("createdAt") AT TIME ZONE 'UTC' AS "lastUsedAt"
    FROM base
    GROUP BY ${GROUPING_SETS}`;
  return rows.flatMap((row): UsageAggregateRow[] => {
    const set = SET_BY_GROUPING.get(Number(row.grouping));
    if (!set) return [];
    return [{
      amounts: amountsOf(row),
      bucket: text(row.bucket),
      category: row.category === null ? null : category(row.category),
      lastUsedAt: instant(row.lastUsedAt),
      model: text(row.model),
      purpose: row.purpose === null ? null : purpose(row.purpose),
      scope: row.scope === null ? null : scope(row.scope),
      set,
      userCount: count(row.userCount),
      userId: text(row.userId)
    }];
  });
}

async function comparisonTotals(tx: Tx, range: Range): Promise<UsageComparisonTotals> {
  const [row] = await tx.$queryRaw<Array<Record<string, unknown>>>`
    SELECT COUNT(DISTINCT ue."userId") AS "activeUserCount", COUNT(DISTINCT ue."modelRunId") AS "runCount",
      SUM(ue."estimatedCostMicros") AS "estimatedCostMicros", SUM(ue."totalTokens") AS "totalTokens",
      SUM(ue."estimatedCostMicros") FILTER (WHERE NOT (${PERSONAL})) AS "systemEstimatedCostMicros"
    FROM "UsageEvent" ue WHERE ${inRange(range)}`;
  return {
    activeUserCount: count(row?.activeUserCount),
    estimatedCostMicros: nullableCount(row?.estimatedCostMicros),
    runCount: count(row?.runCount),
    systemEstimatedCostMicros: nullableCount(row?.systemEstimatedCostMicros),
    totalTokens: nullableCount(row?.totalTokens)
  };
}

async function usersById(tx: Tx, ids: readonly string[]): Promise<UsageUserSource[]> {
  if (ids.length === 0) return [];
  return tx.user.findMany({
    select: {
      displayName: true, email: true, id: true,
      groups: { orderBy: { group: { name: "asc" } }, select: { groupId: true, role: true, group: { select: { name: true } } } }
    },
    where: { id: { in: [...ids] } }
  });
}

function isPostgresInvalidParameter(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2010") return false;
  return (error.meta as { code?: unknown } | undefined)?.code === "22023";
}

async function inSnapshot<T>(client: PrismaClient, read: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await client.$transaction(read, TRANSACTION_OPTIONS);
  } catch (error) {
    // The only caller-controlled parameter PostgreSQL validates is the zone.
    if (isPostgresInvalidParameter(error)) throw new UsageTimeZoneUnsupportedError();
    throw error;
  }
}

async function planFor(tx: Tx, input: UsageReadInput): Promise<UsageWindowPlan> {
  return planUsageWindow({
    earliestUsageAt: input.period === "all" ? await earliestUsageAt(tx) : null,
    now: input.now,
    period: input.period,
    timeZone: input.timeZone
  });
}

function hasStart(plan: UsageWindowPlan): plan is UsageWindowPlan & { from: Date } {
  return plan.from !== null;
}

export function createAdminUsageRepository(client: PrismaClient): AdminUsageRepository {
  return {
    readAnalytics: (input) => inSnapshot(client, async (tx) => {
      const plan = await planFor(tx, input);
      const userCount = await tx.user.count();
      const groups = await tx.group.findMany({
        select: { _count: { select: { users: true } }, archivedAt: true, id: true, name: true }
      });
      const groupSources = groups.map((group) => ({
        archivedAt: group.archivedAt, id: group.id, memberCount: group._count.users, name: group.name
      }));
      if (!hasStart(plan)) {
        return serializeAdminUsageAnalytics({ groups: groupSources, models: new Map(), plan, previous: null, rows: [], userCount, users: [] });
      }
      const { keys, models } = await resolveModelKeys(tx, plan);
      const rows = await aggregateRows(tx, plan, keys);
      const previous = plan.previous ? await comparisonTotals(tx, plan.previous) : null;
      const userIds = rows.flatMap((row) => row.set === "user" && row.userId !== null ? [row.userId] : []);
      const users = await usersById(tx, userIds);
      return serializeAdminUsageAnalytics({ groups: groupSources, models, plan, previous, rows, userCount, users });
    }),

    readExport: (input) => inSnapshot(client, async (tx) => {
      const plan = await planFor(tx, input);
      if (!hasStart(plan)) return { models: new Map(), plan, rows: [], users: new Map() };
      const { keys, models } = await resolveModelKeys(tx, plan);
      const raw = await tx.$queryRaw<Array<Record<string, unknown>>>`
        WITH ${baseRows(plan, keys)}
        SELECT "bucket", "userId", "model", "category", "purpose", ${AMOUNTS}
        FROM base
        GROUP BY "bucket", "userId", "model", "category", "purpose"
        LIMIT ${MAX_USAGE_EXPORT_ROWS + 1}`;
      if (raw.length > MAX_USAGE_EXPORT_ROWS) return null;
      const rows = raw.map((row): UsageExportRow => ({
        amounts: amountsOf(row),
        bucket: text(row.bucket) ?? "",
        category: category(row.category),
        model: text(row.model) ?? "",
        purpose: purpose(row.purpose),
        userId: text(row.userId) ?? ""
      }));
      const users = await usersById(tx, [...new Set(rows.map((row) => row.userId))]);
      return { models, plan, rows, users: new Map(users.map((user) => [user.id, user])) };
    })
  };
}
