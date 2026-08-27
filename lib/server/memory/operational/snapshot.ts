import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { memoryAdmissibleEntityAliasPredicate } from
  "../learning/entities/authority";

const SNAPSHOT_VERSION = "memory-operational-snapshot-v2";
const codePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

type CountRow = Readonly<Record<string, string>>;
type GroupedCountRow = Readonly<{
  code: string;
  count: string;
  family: "degradation" | "observation_rejection";
}>;
type DistributionRow = Readonly<{
  p50Ms: number | null;
  p95Ms: number | null;
  samples: string;
  stage: string;
}>;
type UsageRow = Readonly<{
  cachedInputTokens: string;
  costMicros: string;
  executions: string;
  inputTokens: string;
  outputTokens: string;
  reasoningTokens: string;
  totalTokens: string;
}>;

export type MemoryOperationalCodeCount = Readonly<{
  code: string;
  count: number;
}>;

export type MemoryOperationalDistribution = Readonly<{
  p50Ms: number | null;
  p95Ms: number | null;
  samples: number;
  stage: string;
}>;

export type MemoryOperationalSnapshot = Readonly<{
  adjudication: Readonly<{
    accepted: number;
    required: number;
    unknown: number;
  }>;
  aliases: Readonly<{
    invalidated: number;
    valid: number;
    zeroSupport: number;
  }>;
  entities: Readonly<{
    ambiguous: number;
    created: number;
    merged: number;
    retracted: number;
    reused: number;
  }>;
  embeddings: Readonly<{
    batchItems: number;
    failedItems: number;
    providerRequests: number;
    settledItems: number;
    staleItems: number;
  }>;
  extraction: Readonly<{
    applyRetried: number;
    outcomeUnknown: number;
    recovered: number;
    staged: number;
  }>;
  history: Readonly<{
    chunksBuilt: number;
    chunksReplaced: number;
    digestFullRebuild: number;
    digestIncremental: number;
    digestNoop: number;
    messagesProjected: number;
  }>;
  latencies: readonly MemoryOperationalDistribution[];
  observations: Readonly<{
    accepted: number;
    rejected: number;
    rejectionReasons: readonly MemoryOperationalCodeCount[];
  }>;
  patterns: Readonly<{
    indexed: number;
    rebuilt: number;
    rejected: number;
    rejoined: number;
    replaced: number;
  }>;
  pendingAge: Readonly<{
    relation: MemoryOperationalDistribution;
    safety: MemoryOperationalDistribution;
  }>;
  retrieval: Readonly<{
    degradationReasons: readonly MemoryOperationalCodeCount[];
    degraded: number;
    mandatoryFenceFailClosed: number;
  }>;
  semanticOutcomes: Readonly<{
    conflict: number;
    merge: number;
    reinforce: number;
    replay: number;
    supersede: number;
  }>;
  usage: Readonly<{
    cachedInputTokens: number;
    costMicros: number;
    executions: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  }>;
  version: typeof SNAPSHOT_VERSION;
  window: Readonly<{ from: string; to: string }>;
}>;

function safeCount(value: string | undefined): number {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("memory_operational_count_invalid");
  }
  const parsed = BigInt(value);
  return parsed > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(parsed);
}

function safeMilliseconds(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("memory_operational_distribution_invalid");
  }
  return Math.round(value * 100) / 100;
}

function distribution(row: DistributionRow): MemoryOperationalDistribution {
  if (!codePattern.test(row.stage)) {
    throw new Error("memory_operational_stage_invalid");
  }
  return Object.freeze({
    p50Ms: safeMilliseconds(row.p50Ms),
    p95Ms: safeMilliseconds(row.p95Ms),
    samples: safeCount(row.samples),
    stage: row.stage
  });
}

function codeCounts(
  rows: readonly GroupedCountRow[],
  family: GroupedCountRow["family"]
): readonly MemoryOperationalCodeCount[] {
  return Object.freeze(rows.filter((row) => row.family === family).map((row) => {
    if (!codePattern.test(row.code)) {
      throw new Error("memory_operational_reason_invalid");
    }
    return Object.freeze({ code: row.code, count: safeCount(row.count) });
  }));
}

function validWindow(from: Date, to: Date): boolean {
  const duration = to.getTime() - from.getTime();
  return Number.isFinite(from.getTime()) && Number.isFinite(to.getTime()) &&
    duration > 0 && duration <= 31 * 24 * 60 * 60_000;
}

export async function loadMemoryOperationalSnapshot(
  client: Pick<PrismaClient, "$queryRaw"> = prisma,
  input: Readonly<{ from: Date; to: Date }>
): Promise<MemoryOperationalSnapshot> {
  if (!validWindow(input.from, input.to)) {
    throw new Error("memory_operational_window_invalid");
  }
  const [countRows, groupedRows, latencyRows, pendingRows, usageRows] =
    await Promise.all([
      client.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT
          (SELECT COUNT(*) FROM "MemoryFactExtractionExecution"
            WHERE "createdAt" >= ${input.from} AND "createdAt" < ${input.to}
          )::text AS "extractionStaged",
          (SELECT COUNT(*) FROM "MemoryFactExtractionExecution" execution
            INNER JOIN "MemoryJob" job ON job."id" = execution."memoryJobId"
              AND job."userId" = execution."userId"
            WHERE execution."createdAt" >= ${input.from}
              AND execution."createdAt" < ${input.to}
              AND job."attemptCount" > 1
          )::text AS "extractionRecovered",
          (SELECT COUNT(*) FROM "MemoryFactExtractionExecution" execution
            INNER JOIN "MemoryJob" job ON job."id" = execution."memoryJobId"
              AND job."userId" = execution."userId"
            WHERE execution."appliedAt" >= ${input.from}
              AND execution."appliedAt" < ${input.to}
              AND job."attemptCount" > 1
          )::text AS "extractionApplyRetried",
          (SELECT COUNT(*) FROM "MemoryExecutionBinding"
            WHERE "logicalRole" = 'MEMORY_FACT_EXTRACT'
              AND "state" = 'OUTCOME_UNKNOWN'::"MemoryExecutionState"
              AND "createdAt" >= ${input.from} AND "createdAt" < ${input.to}
          )::text AS "extractionOutcomeUnknown",
          (SELECT COUNT(*) FROM "MemoryFactExtractionCandidateReceipt"
            WHERE "updatedAt" >= ${input.from} AND "updatedAt" < ${input.to}
              AND "outcome" IN (
                'APPLIED'::"MemoryFactExtractionCandidateOutcome",
                'MERGED'::"MemoryFactExtractionCandidateOutcome",
                'REINFORCED'::"MemoryFactExtractionCandidateOutcome",
                'REPLAY'::"MemoryFactExtractionCandidateOutcome",
                'SUPERSEDED'::"MemoryFactExtractionCandidateOutcome"
              )
          )::text AS "observationsAccepted",
          (SELECT COUNT(*) FROM "MemoryFactExtractionCandidateReceipt"
            WHERE "updatedAt" >= ${input.from} AND "updatedAt" < ${input.to}
              AND "outcome" IN (
                'REJECTED'::"MemoryFactExtractionCandidateOutcome",
                'STALE'::"MemoryFactExtractionCandidateOutcome"
              )
          )::text AS "observationsRejected",
          (SELECT COUNT(*) FROM "MemoryFactExtractionCandidateReceipt"
            WHERE "updatedAt" >= ${input.from} AND "updatedAt" < ${input.to}
              AND "outcome" = 'REPLAY'::"MemoryFactExtractionCandidateOutcome"
          )::text AS "semanticReplay",
          (SELECT COUNT(*) FROM "MemoryFactExtractionCandidateReceipt"
            WHERE "updatedAt" >= ${input.from} AND "updatedAt" < ${input.to}
              AND "outcome" = 'REINFORCED'::"MemoryFactExtractionCandidateOutcome"
          )::text AS "semanticReinforce",
          (SELECT COUNT(*) FROM "MemoryEvent"
            WHERE "createdAt" >= ${input.from} AND "createdAt" < ${input.to}
              AND "operation" = 'MERGE'::"MemoryEventOperation"
          )::text AS "semanticMerge",
          (SELECT COUNT(*) FROM "MemoryEvent"
            WHERE "createdAt" >= ${input.from} AND "createdAt" < ${input.to}
              AND "operation" = 'SUPERSEDE'::"MemoryEventOperation"
          )::text AS "semanticSupersede",
          (SELECT COUNT(*) FROM "MemoryEvent"
            WHERE "createdAt" >= ${input.from} AND "createdAt" < ${input.to}
              AND "operation" = 'CONFLICT'::"MemoryEventOperation"
          )::text AS "semanticConflict",
          (SELECT COUNT(*) FROM "MemoryAuxiliarySemanticCall"
            WHERE "purpose" = 'FACT_EXTRACTION_ADJUDICATION'
              AND "createdAt" >= ${input.from} AND "createdAt" < ${input.to}
          )::text AS "adjudicationRequired",
          (SELECT COUNT(*) FROM "MemoryAuxiliarySemanticCall" call
            INNER JOIN "MemoryExecutionBinding" binding
              ON binding."userId" = call."userId" AND binding."id" = call."executionId"
            WHERE call."purpose" = 'FACT_EXTRACTION_ADJUDICATION'
              AND call."completedAt" >= ${input.from}
              AND call."completedAt" < ${input.to}
              AND binding."state" = 'SUCCEEDED'::"MemoryExecutionState"
          )::text AS "adjudicationAccepted",
          (SELECT COUNT(*) FROM "MemoryAuxiliarySemanticCall" call
            LEFT JOIN "MemoryExecutionBinding" binding
              ON binding."userId" = call."userId" AND binding."id" = call."executionId"
            WHERE call."purpose" = 'FACT_EXTRACTION_ADJUDICATION'
              AND call."createdAt" >= ${input.from} AND call."createdAt" < ${input.to}
              AND (call."completedAt" IS NULL OR binding."state" =
                'OUTCOME_UNKNOWN'::"MemoryExecutionState")
          )::text AS "adjudicationUnknown",
          (SELECT COUNT(*) FROM "MemoryEntity"
            WHERE "createdAt" >= ${input.from} AND "createdAt" < ${input.to}
          )::text AS "entitiesCreated",
          (SELECT COUNT(*) FROM "MemoryFactVersionEntity" link
            INNER JOIN "MemoryEntity" entity
              ON entity."userId" = link."userId" AND entity."id" = link."entityId"
            WHERE link."createdAt" >= ${input.from} AND link."createdAt" < ${input.to}
              AND link."createdAt" > entity."createdAt"
          )::text AS "entitiesReused",
          (SELECT COUNT(*) FROM "MemoryEntity"
            WHERE "updatedAt" >= ${input.from} AND "updatedAt" < ${input.to}
              AND "state" = 'MERGED'::"MemoryEntityState"
          )::text AS "entitiesMerged",
          (SELECT COUNT(*) FROM "MemoryEntity"
            WHERE "updatedAt" >= ${input.from} AND "updatedAt" < ${input.to}
              AND "state" = 'RETRACTED'::"MemoryEntityState"
          )::text AS "entitiesRetracted",
          (SELECT COUNT(*) FROM "MemoryFactExtractionCandidateReceipt" receipt
            INNER JOIN "MemoryFactExtractionExecution" execution
              ON execution."userId" = receipt."userId"
              AND execution."id" = receipt."extractionExecutionId"
            INNER JOIN "MemoryAuxiliarySemanticCall" call
              ON call."userId" = execution."userId"
              AND call."ownerJobId" = execution."memoryJobId"
              AND call."purpose" = 'FACT_EXTRACTION_ADJUDICATION'
            WHERE receipt."updatedAt" >= ${input.from}
              AND receipt."updatedAt" < ${input.to}
              AND receipt."outcome" = 'REJECTED'::"MemoryFactExtractionCandidateOutcome"
              AND receipt."reasonCode" = 'semantic_not_admitted'
          )::text AS "entitiesAmbiguous",
          (SELECT COUNT(*) FROM "MemoryEntityAlias" alias
            WHERE ${memoryAdmissibleEntityAliasPredicate(
              Prisma.sql`alias."userId"`
            )}
          )::text AS "aliasesValid",
          (SELECT COUNT(*) FROM "MemoryEntityAlias" alias
            WHERE EXISTS (SELECT 1 FROM "MemoryEntityAliasSupport" support
              WHERE support."userId" = alias."userId"
                AND support."aliasId" = alias."id")
              AND NOT (${memoryAdmissibleEntityAliasPredicate(
                Prisma.sql`alias."userId"`
              )})
          )::text AS "aliasesInvalidated",
          (SELECT COUNT(*) FROM "MemoryEntityAlias" alias
            WHERE NOT EXISTS (SELECT 1 FROM "MemoryEntityAliasSupport" support
              WHERE support."userId" = alias."userId"
                AND support."aliasId" = alias."id")
          )::text AS "aliasesZeroSupport",
          (SELECT COUNT(*) FROM "MemorySearchEntry" search
            INNER JOIN "MemoryFactVersion" version
              ON version."userId" = search."userId"
              AND version."id" = search."factVersionId"
            WHERE version."modality" = 'PATTERN'::"MemoryFactModality"
              AND search."createdAt" >= ${input.from}
              AND search."createdAt" < ${input.to}
          )::text AS "patternsIndexed",
          (SELECT COUNT(*) FROM "MemorySearchEntry" search
            INNER JOIN "MemoryFactVersion" version
              ON version."userId" = search."userId"
              AND version."id" = search."factVersionId"
            INNER JOIN "MemoryIndexGeneration" generation
              ON generation."userId" = search."userId"
              AND generation."id" = search."indexGenerationId"
            WHERE version."modality" = 'PATTERN'::"MemoryFactModality"
              AND generation."sourceIndexGenerationId" IS NOT NULL
              AND search."createdAt" >= ${input.from}
              AND search."createdAt" < ${input.to}
          )::text AS "patternsRebuilt",
          (SELECT COUNT(*) FROM "ModelRunMemoryItem" item
            INNER JOIN "MemoryFactVersion" version
              ON version."userId" = item."userId"
              AND version."id" = item."factVersionId"
            WHERE version."modality" = 'PATTERN'::"MemoryFactModality"
              AND item."createdAt" >= ${input.from} AND item."createdAt" < ${input.to}
          )::text AS "patternsRejoined",
          (SELECT COUNT(*) FROM "MemoryFactVersion"
            WHERE "modality" = 'PATTERN'::"MemoryFactModality"
              AND "createdAt" >= ${input.from} AND "createdAt" < ${input.to}
              AND ("safetyClassificationState" <> 'CLASSIFIED'::
                "MemorySafetyClassificationState" OR "state" IN (
                  'CONFLICTING'::"MemoryFactVersionState",
                  'FORGOTTEN'::"MemoryFactVersionState",
                  'RETRACTED'::"MemoryFactVersionState"
                ))
          )::text AS "patternsRejected",
          (SELECT COUNT(*) FROM "MemoryEvent" event
            INNER JOIN "MemoryFactVersion" version
              ON version."userId" = event."userId"
              AND version."id" = event."factVersionId"
            WHERE version."modality" = 'PATTERN'::"MemoryFactModality"
              AND event."createdAt" >= ${input.from} AND event."createdAt" < ${input.to}
              AND event."operation" IN (
                'SUPERSEDE'::"MemoryEventOperation",
                'RETRACT'::"MemoryEventOperation"
              )
          )::text AS "patternsReplaced",
          (SELECT COUNT(*) FROM "MemoryRetrievalAttempt"
            WHERE "createdAt" >= ${input.from} AND "createdAt" < ${input.to}
              AND "outcome" = 'DEGRADED'::"MemoryReceiptOutcome"
          )::text AS "retrievalDegraded",
          (SELECT COUNT(*) FROM "MemoryRetrievalAttempt"
            WHERE "createdAt" >= ${input.from} AND "createdAt" < ${input.to}
              AND "outcome" = 'FAILED_SAFE'::"MemoryReceiptOutcome"
          )::text AS "mandatoryFenceFailClosed",
          (SELECT COALESCE(SUM(("operationalCounters" ->>
              'historyMessagesProjected')::NUMERIC), 0)
            FROM "MemoryJob" WHERE "completedAt" >= ${input.from}
              AND "completedAt" < ${input.to}
          )::text AS "historyMessagesProjected",
          (SELECT COALESCE(SUM(("operationalCounters" ->>
              'historyChunksBuilt')::NUMERIC), 0)
            FROM "MemoryJob" WHERE "completedAt" >= ${input.from}
              AND "completedAt" < ${input.to}
          )::text AS "historyChunksBuilt",
          (SELECT COALESCE(SUM(("operationalCounters" ->>
              'historyChunksReplaced')::NUMERIC), 0)
            FROM "MemoryJob" WHERE "completedAt" >= ${input.from}
              AND "completedAt" < ${input.to}
          )::text AS "historyChunksReplaced",
          (SELECT COALESCE(SUM(("operationalCounters" ->>
              'digestNoop')::NUMERIC), 0)
            FROM "MemoryJob" WHERE "completedAt" >= ${input.from}
              AND "completedAt" < ${input.to}
          )::text AS "digestNoop",
          (SELECT COALESCE(SUM(("operationalCounters" ->>
              'digestIncremental')::NUMERIC), 0)
            FROM "MemoryJob" WHERE "completedAt" >= ${input.from}
              AND "completedAt" < ${input.to}
          )::text AS "digestIncremental",
          (SELECT COALESCE(SUM(("operationalCounters" ->>
              'digestFullRebuild')::NUMERIC), 0)
            FROM "MemoryJob" WHERE "completedAt" >= ${input.from}
              AND "completedAt" < ${input.to}
          )::text AS "digestFullRebuild",
          (SELECT COALESCE(SUM(("operationalCounters" ->>
              'embeddingBatchItems')::NUMERIC), 0)
            FROM "MemoryJob" WHERE "completedAt" >= ${input.from}
              AND "completedAt" < ${input.to}
          )::text AS "embeddingBatchItems",
          (SELECT COALESCE(SUM(("operationalCounters" ->>
              'embeddingFailedItems')::NUMERIC), 0)
            FROM "MemoryJob" WHERE "completedAt" >= ${input.from}
              AND "completedAt" < ${input.to}
          )::text AS "embeddingFailedItems",
          (SELECT COALESCE(SUM(("operationalCounters" ->>
              'embeddingProviderRequests')::NUMERIC), 0)
            FROM "MemoryJob" WHERE "completedAt" >= ${input.from}
              AND "completedAt" < ${input.to}
          )::text AS "embeddingProviderRequests",
          (SELECT COALESCE(SUM(("operationalCounters" ->>
              'embeddingSettledItems')::NUMERIC), 0)
            FROM "MemoryJob" WHERE "completedAt" >= ${input.from}
              AND "completedAt" < ${input.to}
          )::text AS "embeddingSettledItems",
          (SELECT COALESCE(SUM(("operationalCounters" ->>
              'embeddingStaleItems')::NUMERIC), 0)
            FROM "MemoryJob" WHERE "completedAt" >= ${input.from}
              AND "completedAt" < ${input.to}
          )::text AS "embeddingStaleItems"
      `),
      client.$queryRaw<GroupedCountRow[]>(Prisma.sql`
        SELECT family, code, COUNT(*)::text AS count
        FROM (
          SELECT 'observation_rejection'::text AS family,
            COALESCE(receipt."reasonCode", 'unspecified') AS code
          FROM "MemoryFactExtractionCandidateReceipt" receipt
          WHERE receipt."updatedAt" >= ${input.from}
            AND receipt."updatedAt" < ${input.to}
            AND receipt."outcome" IN (
              'REJECTED'::"MemoryFactExtractionCandidateOutcome",
              'STALE'::"MemoryFactExtractionCandidateOutcome"
            )
          UNION ALL
          SELECT 'degradation'::text AS family,
            attempt."degradationCode" AS code
          FROM "MemoryRetrievalAttempt" attempt
          WHERE attempt."createdAt" >= ${input.from}
            AND attempt."createdAt" < ${input.to}
            AND attempt."degradationCode" IS NOT NULL
        ) grouped
        GROUP BY family, code
        ORDER BY family, code
        LIMIT 256
      `),
      client.$queryRaw<DistributionRow[]>(Prisma.sql`
        SELECT stage, COUNT(*)::text AS samples,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY milliseconds)::float8 AS "p50Ms",
          percentile_cont(0.95) WITHIN GROUP (ORDER BY milliseconds)::float8 AS "p95Ms"
        FROM (
          SELECT ('job.' || job."kind"::text) AS stage,
            EXTRACT(EPOCH FROM (job."completedAt" - job."createdAt")) * 1000
              AS milliseconds
          FROM "MemoryJob" job
          WHERE job."completedAt" >= ${input.from} AND job."completedAt" < ${input.to}
          UNION ALL
          SELECT ('provider.' || binding."logicalRole") AS stage,
            EXTRACT(EPOCH FROM (binding."completedAt" - binding."startedAt")) * 1000
          FROM "MemoryExecutionBinding" binding
          WHERE binding."completedAt" >= ${input.from}
            AND binding."completedAt" < ${input.to}
            AND binding."startedAt" IS NOT NULL
          UNION ALL
          SELECT 'stage.extraction_apply' AS stage,
            EXTRACT(EPOCH FROM (execution."appliedAt" - execution."createdAt")) * 1000
          FROM "MemoryFactExtractionExecution" execution
          WHERE execution."appliedAt" >= ${input.from}
            AND execution."appliedAt" < ${input.to}
        ) samples
        WHERE milliseconds >= 0
        GROUP BY stage
        ORDER BY stage
        LIMIT 128
      `),
      client.$queryRaw<DistributionRow[]>(Prisma.sql`
        SELECT stage, COUNT(*)::text AS samples,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY milliseconds)::float8 AS "p50Ms",
          percentile_cont(0.95) WITHIN GROUP (ORDER BY milliseconds)::float8 AS "p95Ms"
        FROM (
          SELECT 'pending.relation' AS stage,
            EXTRACT(EPOCH FROM (${input.to} - version."createdAt")) * 1000
              AS milliseconds
          FROM "MemoryFactVersion" version
          WHERE version."state" = 'PENDING_RELATION'::"MemoryFactVersionState"
          UNION ALL
          SELECT 'pending.safety' AS stage,
            EXTRACT(EPOCH FROM (${input.to} - version."createdAt")) * 1000
          FROM "MemoryFactVersion" version
          WHERE version."safetyClassificationState" =
            'PENDING'::"MemorySafetyClassificationState"
            AND version."state" IN (
              'ACTIVE'::"MemoryFactVersionState",
              'PENDING_RELATION'::"MemoryFactVersionState"
            )
        ) samples
        WHERE milliseconds >= 0
        GROUP BY stage
        ORDER BY stage
      `),
      client.$queryRaw<UsageRow[]>(Prisma.sql`
        SELECT COUNT(*)::text AS executions,
          COALESCE(SUM("inputTokens"), 0)::text AS "inputTokens",
          COALESCE(SUM("cachedInputTokens"), 0)::text AS "cachedInputTokens",
          COALESCE(SUM("outputTokens"), 0)::text AS "outputTokens",
          COALESCE(SUM("reasoningTokens"), 0)::text AS "reasoningTokens",
          COALESCE(SUM("totalTokens"), 0)::text AS "totalTokens",
          COALESCE(SUM("estimatedCostMicros"), 0)::text AS "costMicros"
        FROM "MemoryExecutionBinding"
        WHERE "createdAt" >= ${input.from} AND "createdAt" < ${input.to}
          AND "usageCompleteness" = 'COMPLETE'::"MemoryUsageCompleteness"
      `)
    ]);

  const counts = countRows[0];
  const usage = usageRows[0];
  if (!counts || !usage) throw new Error("memory_operational_snapshot_unavailable");
  const pending = new Map(pendingRows.map((row) => [row.stage, distribution(row)]));
  const emptyPending = (stage: string): MemoryOperationalDistribution =>
    Object.freeze({ p50Ms: null, p95Ms: null, samples: 0, stage });

  return Object.freeze({
    adjudication: Object.freeze({
      accepted: safeCount(counts.adjudicationAccepted),
      required: safeCount(counts.adjudicationRequired),
      unknown: safeCount(counts.adjudicationUnknown)
    }),
    aliases: Object.freeze({
      invalidated: safeCount(counts.aliasesInvalidated),
      valid: safeCount(counts.aliasesValid),
      zeroSupport: safeCount(counts.aliasesZeroSupport)
    }),
    entities: Object.freeze({
      ambiguous: safeCount(counts.entitiesAmbiguous),
      created: safeCount(counts.entitiesCreated),
      merged: safeCount(counts.entitiesMerged),
      retracted: safeCount(counts.entitiesRetracted),
      reused: safeCount(counts.entitiesReused)
    }),
    embeddings: Object.freeze({
      batchItems: safeCount(counts.embeddingBatchItems),
      failedItems: safeCount(counts.embeddingFailedItems),
      providerRequests: safeCount(counts.embeddingProviderRequests),
      settledItems: safeCount(counts.embeddingSettledItems),
      staleItems: safeCount(counts.embeddingStaleItems)
    }),
    extraction: Object.freeze({
      applyRetried: safeCount(counts.extractionApplyRetried),
      outcomeUnknown: safeCount(counts.extractionOutcomeUnknown),
      recovered: safeCount(counts.extractionRecovered),
      staged: safeCount(counts.extractionStaged)
    }),
    history: Object.freeze({
      chunksBuilt: safeCount(counts.historyChunksBuilt),
      chunksReplaced: safeCount(counts.historyChunksReplaced),
      digestFullRebuild: safeCount(counts.digestFullRebuild),
      digestIncremental: safeCount(counts.digestIncremental),
      digestNoop: safeCount(counts.digestNoop),
      messagesProjected: safeCount(counts.historyMessagesProjected)
    }),
    latencies: Object.freeze(latencyRows.map(distribution)),
    observations: Object.freeze({
      accepted: safeCount(counts.observationsAccepted),
      rejected: safeCount(counts.observationsRejected),
      rejectionReasons: codeCounts(groupedRows, "observation_rejection")
    }),
    patterns: Object.freeze({
      indexed: safeCount(counts.patternsIndexed),
      rebuilt: safeCount(counts.patternsRebuilt),
      rejected: safeCount(counts.patternsRejected),
      rejoined: safeCount(counts.patternsRejoined),
      replaced: safeCount(counts.patternsReplaced)
    }),
    pendingAge: Object.freeze({
      relation: pending.get("pending.relation") ?? emptyPending("pending.relation"),
      safety: pending.get("pending.safety") ?? emptyPending("pending.safety")
    }),
    retrieval: Object.freeze({
      degradationReasons: codeCounts(groupedRows, "degradation"),
      degraded: safeCount(counts.retrievalDegraded),
      mandatoryFenceFailClosed: safeCount(counts.mandatoryFenceFailClosed)
    }),
    semanticOutcomes: Object.freeze({
      conflict: safeCount(counts.semanticConflict),
      merge: safeCount(counts.semanticMerge),
      reinforce: safeCount(counts.semanticReinforce),
      replay: safeCount(counts.semanticReplay),
      supersede: safeCount(counts.semanticSupersede)
    }),
    usage: Object.freeze({
      cachedInputTokens: safeCount(usage.cachedInputTokens),
      costMicros: safeCount(usage.costMicros),
      executions: safeCount(usage.executions),
      inputTokens: safeCount(usage.inputTokens),
      outputTokens: safeCount(usage.outputTokens),
      reasoningTokens: safeCount(usage.reasoningTokens),
      totalTokens: safeCount(usage.totalTokens)
    }),
    version: SNAPSHOT_VERSION,
    window: Object.freeze({
      from: input.from.toISOString(),
      to: input.to.toISOString()
    })
  });
}
