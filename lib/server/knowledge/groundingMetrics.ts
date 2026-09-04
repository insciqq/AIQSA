import { Prisma, type PrismaClient } from "@prisma/client";
import type { KnowledgeAnswerSettlementV5 } from "./answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_SCOPE_V6_CLOSURE_MAX_OPERATION_COUNT_V1,
  KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2
} from "./answerGroundingV21";
import {
  KNOWLEDGE_TARGETED_SUPPLEMENT_ATOMIC_BUDGET_V1
} from "./answerGroundingCorrectionV21";

const groundingStages = Object.freeze([
  "primary",
  "initial",
  "repair",
  "auditor",
  "auditor_repair",
  "scope",
  "scope_repair",
  "scope_completeness",
  "scope_completeness_repair",
  "scope_closure",
  "scope_closure_repair",
  "supplement",
  "final"
] as const);

type KnowledgeGroundingStage = typeof groundingStages[number];

type KnowledgeGroundingMetricsEvidenceV18 = Readonly<{
  audit: Readonly<{ dimensionCount: number; missingDimensionCount: number; status: "accepted" }>;
  contradictedClaimCount: number;
  correctionAttempted: boolean;
  correctionSucceeded: boolean;
  draftClaimCount: number;
  operations: readonly Readonly<{
    durationMs: number;
    role: KnowledgeGroundingStage;
    usage: Readonly<{ inputTokens: number | null; outputTokens: number | null }>;
  }>[];
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  version: 18;
}>;

type KnowledgeGroundingMetricsEvidenceV19 = Readonly<{
  closure?: Readonly<{
    initialCoveredDimensionCount?: number;
    initialExcludedDimensionCount?: number;
    reopenedCoveredDimensionCount?: number;
    reopenedDimensionCount: number;
    reopenedExcludedDimensionCount?: number;
    status: "accepted";
  }> | null;
  completeness?: Readonly<{
    addedDimensionCount: number;
    status: "accepted";
  }>;
  contradictedClaimCount: number;
  correctionAttempted: boolean;
  correctionSucceeded: boolean;
  crossTargetExactRepeatCount?: number;
  coverage: Readonly<{
    excludedDimensionCount?: number;
    missingDimensionCount: number;
    status: "accepted";
  }>;
  coverageScope: Readonly<{ dimensionCount: number; status: "accepted" }>;
  draftClaimCount: number;
  finalSelectorFallbackApplied?: boolean;
  operations: readonly Readonly<{
    durationMs: number;
    role: KnowledgeGroundingStage;
    usage: Readonly<{ inputTokens: number | null; outputTokens: number | null }>;
  }>[];
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  version: 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 |
    33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 |
    49 | 50 | 51 | 52 | 53 | 54 | 55 | 56 | 57;
}>;

type KnowledgeGroundingMetricsEvidence = KnowledgeGroundingMetricsEvidenceV18 |
  KnowledgeGroundingMetricsEvidenceV19;

export type KnowledgeGroundingStageOperationalMetrics = Readonly<{
  calls: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}>;

/** Content-free aggregate backing the PRD's grounding counters/histograms. */
export type KnowledgeGroundingOperationalMetrics = Readonly<{
  answers: number;
  auditAccepted: number;
  coverageScopeAccepted: number;
  coverage: Readonly<{ complete: number; none: number; partial: number }>;
  correctionAttempted: number;
  correctionSucceeded: number;
  draftClaims: number;
  modelOperations: number;
  pipelineVersion21: number;
  scopeCompletenessAccepted: number;
  scopeClosureAccepted: number;
  selectorContradicted: number;
  selectorSupported: number;
  selectorUnsupported: number;
  stages: Readonly<Record<KnowledgeGroundingStage, KnowledgeGroundingStageOperationalMetrics>>;
  totalCoverageDimensions: number;
  totalCrossTargetExactRepeatCount: number;
  totalExcludedCoverageDimensions: number;
  totalMissingCoverageDimensions: number;
  totalScopeCompletenessAdditions: number;
  totalScopeClosureReopenedDimensions: number;
}>;

function percentile(sorted: readonly number[], ratio: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

export function aggregateKnowledgeGroundingMetrics(
  evidences: readonly KnowledgeGroundingMetricsEvidence[]
): KnowledgeGroundingOperationalMetrics {
  const stageValues = Object.fromEntries(groundingStages.map((stage) => [stage, {
    durations: [] as number[],
    inputTokens: 0,
    outputTokens: 0
  }])) as Record<KnowledgeGroundingStage, {
    durations: number[];
    inputTokens: number;
    outputTokens: number;
  }>;
  const coverage = { complete: 0, none: 0, partial: 0 };
  let correctionAttempted = 0;
  let correctionSucceeded = 0;
  let draftClaims = 0;
  let modelOperations = 0;
  let selectorContradicted = 0;
  let selectorSupported = 0;
  let selectorUnsupported = 0;
  let totalCoverageDimensions = 0;
  let totalCrossTargetExactRepeatCount = 0;
  let totalExcludedCoverageDimensions = 0;
  let totalMissingCoverageDimensions = 0;
  let totalScopeCompletenessAdditions = 0;
  let totalScopeClosureReopenedDimensions = 0;
  for (const evidence of evidences) {
    coverage[evidence.requestCoverage] += 1;
    correctionAttempted += Number(evidence.correctionAttempted);
    correctionSucceeded += Number(evidence.correctionSucceeded);
    draftClaims += evidence.draftClaimCount;
    selectorContradicted += evidence.contradictedClaimCount;
    selectorSupported += evidence.supportedClaimCount;
    selectorUnsupported += evidence.unsupportedClaimCount;
    totalCrossTargetExactRepeatCount += evidence.version === 54 || evidence.version === 55 ||
      evidence.version === 56 || evidence.version === 57
      ? evidence.crossTargetExactRepeatCount ?? 0
      : 0;
    totalCoverageDimensions += evidence.version === 18
      ? evidence.audit.dimensionCount
      : evidence.coverageScope.dimensionCount;
    totalExcludedCoverageDimensions += evidence.version === 23 ||
      evidence.version === 24 || evidence.version === 25 || evidence.version === 26 ||
      evidence.version === 27 || evidence.version === 28 || evidence.version === 29 ||
      evidence.version === 30 || evidence.version === 31 || evidence.version === 32 ||
      evidence.version === 33 || evidence.version === 34 || evidence.version === 35
      || evidence.version === 36 || evidence.version === 37 || evidence.version === 38 ||
      evidence.version === 39 || evidence.version === 40 || evidence.version === 41 ||
      evidence.version === 42 || evidence.version === 43 || evidence.version === 44 ||
      evidence.version === 45 || evidence.version === 46 || evidence.version === 47 ||
      evidence.version === 48 || evidence.version === 49 || evidence.version === 50 ||
      evidence.version === 51 || evidence.version === 52 || evidence.version === 53 ||
      evidence.version === 54 || evidence.version === 55 || evidence.version === 56 ||
      evidence.version === 57
      ? evidence.coverage.excludedDimensionCount ?? 0
      : 0;
    totalMissingCoverageDimensions += evidence.version === 18
      ? evidence.audit.missingDimensionCount
      : evidence.coverage.missingDimensionCount;
    totalScopeCompletenessAdditions += evidence.version === 24 ||
      evidence.version === 25 || evidence.version === 26 || evidence.version === 27 ||
      evidence.version === 28 || evidence.version === 29 || evidence.version === 30 ||
      evidence.version === 31 || evidence.version === 32 || evidence.version === 33
      || evidence.version === 34 || evidence.version === 35
      || evidence.version === 36 || evidence.version === 37 || evidence.version === 38 ||
      evidence.version === 39 || evidence.version === 40 || evidence.version === 41 ||
      evidence.version === 42 || evidence.version === 43 || evidence.version === 44 ||
      evidence.version === 45 || evidence.version === 46 || evidence.version === 47 ||
      evidence.version === 48 || evidence.version === 49 || evidence.version === 50 ||
      evidence.version === 51 || evidence.version === 52 || evidence.version === 53 ||
      evidence.version === 54 || evidence.version === 55 || evidence.version === 56 ||
      evidence.version === 57
      ? evidence.completeness?.addedDimensionCount ?? 0
      : 0;
    totalScopeClosureReopenedDimensions += evidence.version === 34 ||
      evidence.version === 35 || evidence.version === 36 || evidence.version === 37 ||
      evidence.version === 38 || evidence.version === 39 || evidence.version === 40 ||
      evidence.version === 41 || evidence.version === 42 || evidence.version === 43 ||
      evidence.version === 44 || evidence.version === 45 || evidence.version === 46 ||
      evidence.version === 47 || evidence.version === 48 || evidence.version === 49 ||
      evidence.version === 50 || evidence.version === 51 || evidence.version === 52 ||
      evidence.version === 53 || evidence.version === 54 || evidence.version === 55 ||
      evidence.version === 56 || evidence.version === 57
      ? evidence.closure?.reopenedDimensionCount ?? 0
      : 0;
    modelOperations += evidence.operations.length;
    for (const operation of evidence.operations) {
      const stage = stageValues[operation.role];
      stage.durations.push(operation.durationMs);
      stage.inputTokens += operation.usage.inputTokens ?? 0;
      stage.outputTokens += operation.usage.outputTokens ?? 0;
    }
  }
  const stages = Object.fromEntries(groundingStages.map((stage) => {
    const values = stageValues[stage];
    values.durations.sort((left, right) => left - right);
    return [stage, Object.freeze({
      calls: values.durations.length,
      p50DurationMs: percentile(values.durations, 0.5),
      p95DurationMs: percentile(values.durations, 0.95),
      totalDurationMs: values.durations.reduce((total, value) => total + value, 0),
      totalInputTokens: values.inputTokens,
      totalOutputTokens: values.outputTokens
    })];
  })) as Record<KnowledgeGroundingStage, KnowledgeGroundingStageOperationalMetrics>;
  return Object.freeze({
    answers: evidences.length,
    auditAccepted: evidences.filter(({ version }) => version === 18).length,
    coverageScopeAccepted: evidences.filter(({ version }) => version >= 19).length,
    coverage: Object.freeze(coverage),
    correctionAttempted,
    correctionSucceeded,
    draftClaims,
    modelOperations,
    pipelineVersion21: evidences.length,
    scopeCompletenessAccepted: evidences.filter(({ version }) => version >= 24).length,
    scopeClosureAccepted: evidences.filter((evidence) =>
      (evidence.version === 34 || evidence.version === 35 || evidence.version === 36 ||
        evidence.version === 37 || evidence.version === 38 || evidence.version === 39 ||
        evidence.version === 40 || evidence.version === 41 || evidence.version === 42 ||
        evidence.version === 43 || evidence.version === 44 ||
        evidence.version === 45 || evidence.version === 46 ||
        evidence.version === 47 || evidence.version === 48 || evidence.version === 49 ||
        evidence.version === 50 || evidence.version === 51 || evidence.version === 52 ||
        evidence.version === 53 || evidence.version === 54 || evidence.version === 55 ||
        evidence.version === 56 || evidence.version === 57) &&
        evidence.closure !== null).length,
    selectorContradicted,
    selectorSupported,
    selectorUnsupported,
    stages: Object.freeze(stages),
    totalCoverageDimensions,
    totalCrossTargetExactRepeatCount,
    totalExcludedCoverageDimensions,
    totalMissingCoverageDimensions,
    totalScopeCompletenessAdditions,
    totalScopeClosureReopenedDimensions
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function counter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Narrow stored-row guard. It validates every field consumed by the metrics
 * projection and never returns arbitrary JSON fields. */
function metricsEvidence(value: unknown): value is KnowledgeGroundingMetricsEvidence {
  if (!record(value) || value.version !== 18 && value.version !== 19 &&
    value.version !== 20 && value.version !== 21 && value.version !== 22 &&
    value.version !== 23 && value.version !== 24 && value.version !== 25 &&
    value.version !== 26 && value.version !== 27 && value.version !== 28 &&
    value.version !== 29 && value.version !== 30 && value.version !== 31 &&
    value.version !== 32 && value.version !== 33 && value.version !== 34 &&
    value.version !== 35 && value.version !== 36 && value.version !== 37 &&
    value.version !== 38 && value.version !== 39 && value.version !== 40 &&
    value.version !== 41 && value.version !== 42 && value.version !== 43 &&
    value.version !== 44 && value.version !== 45 && value.version !== 46 &&
    value.version !== 47 && value.version !== 48 && value.version !== 49 &&
    value.version !== 50 && value.version !== 51 && value.version !== 52 &&
    value.version !== 53 && value.version !== 54 && value.version !== 55 &&
    value.version !== 56 && value.version !== 57 ||
    typeof value.correctionAttempted !== "boolean" ||
    typeof value.correctionSucceeded !== "boolean" ||
    !counter(value.draftClaimCount) || !counter(value.contradictedClaimCount) ||
    !counter(value.supportedClaimCount) || !counter(value.unsupportedClaimCount) ||
    value.requestCoverage !== "complete" && value.requestCoverage !== "none" &&
    value.requestCoverage !== "partial" || !Array.isArray(value.operations)) return false;
  if (value.version === 18 && (!record(value.audit) ||
    value.audit.status !== "accepted" || !counter(value.audit.dimensionCount) ||
    !counter(value.audit.missingDimensionCount))) return false;
  if (value.version >= 19 && (!record(value.coverageScope) ||
    value.coverageScope.status !== "accepted" ||
    !counter(value.coverageScope.dimensionCount) || !record(value.coverage) ||
    value.coverage.status !== "accepted" ||
    !counter(value.coverage.missingDimensionCount))) return false;
  if (value.version >= 23 && (!record(value.coverage) ||
    !counter(value.coverage.excludedDimensionCount))) return false;
  if (value.version >= 24 && (!record(value.completeness) ||
    value.completeness.status !== "accepted" ||
    !counter(value.completeness.addedDimensionCount))) return false;
  if ((value.version === 54 || value.version === 55 || value.version === 56 ||
    value.version === 57) &&
    (!counter(value.crossTargetExactRepeatCount) ||
    Number(value.crossTargetExactRepeatCount) >=
      KNOWLEDGE_TARGETED_SUPPLEMENT_ATOMIC_BUDGET_V1.maxTotalClaims)) return false;
  if ((value.version === 56 || value.version === 57) &&
    typeof value.finalSelectorFallbackApplied !== "boolean") return false;
  if ((value.version === 34 || value.version === 35 || value.version === 36 ||
    value.version === 37 || value.version === 38 || value.version === 39 ||
    value.version === 40 || value.version === 41 || value.version === 42 ||
    value.version === 43 || value.version === 44 || value.version === 45 ||
    value.version === 46 || value.version === 47 || value.version === 48 ||
    value.version === 49 || value.version === 50 || value.version === 51 ||
    value.version === 52 || value.version === 53 || value.version === 54 ||
    value.version === 55 || value.version === 56 || value.version === 57) &&
    value.closure !== null &&
    (!record(value.closure) ||
    value.closure.status !== "accepted" ||
    !counter(value.closure.reopenedDimensionCount))) return false;
  if ((value.version === 52 || value.version === 53 || value.version === 54 ||
    value.version === 55 || value.version === 56 || value.version === 57) &&
    value.closure !== null &&
    (!record(value.closure) ||
    !counter(value.closure.initialCoveredDimensionCount) ||
    !counter(value.closure.initialExcludedDimensionCount) ||
    !counter(value.closure.reopenedCoveredDimensionCount) ||
    !counter(value.closure.reopenedExcludedDimensionCount) ||
    value.closure.reopenedDimensionCount !==
      value.closure.reopenedCoveredDimensionCount +
        value.closure.reopenedExcludedDimensionCount)) return false;
  const operationLimit = value.version === 35 || value.version === 36 ||
    value.version === 37 || value.version === 38 || value.version === 39 ||
    value.version === 40 || value.version === 41 || value.version === 42 ||
    value.version === 43 || value.version === 44 || value.version === 45 ||
    value.version === 46 || value.version === 47 || value.version === 48 ||
    value.version === 49 || value.version === 50 || value.version === 51 ||
    value.version === 52 || value.version === 53 || value.version === 54 ||
    value.version === 55 || value.version === 56 || value.version === 57
    ? KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2
      : value.version === 25 || value.version === 26 || value.version === 27 ||
        value.version === 28 || value.version === 29 || value.version === 30 ||
        value.version === 31 || value.version === 32 || value.version === 33 ||
        value.version === 34
        ? KNOWLEDGE_ANSWER_SCOPE_V6_CLOSURE_MAX_OPERATION_COUNT_V1
        : 6;
  return value.operations.length >= 3 && value.operations.length <= operationLimit &&
    value.operations.every((operation) => record(operation) &&
      groundingStages.includes(operation.role as KnowledgeGroundingStage) &&
      counter(operation.durationMs) && record(operation.usage) &&
      counter(operation.usage.inputTokens) && counter(operation.usage.outputTokens));
}

const METRICS_ROW_LIMIT = 10_000;

/** Loads V18-V57 content-free receipts; malformed rows are ignored. */
export async function loadKnowledgeGroundingOperationalMetrics(
  client: Pick<PrismaClient, "knowledgeGroundingResult">,
  input: Readonly<{ limit?: number; since?: Date }> = {}
): Promise<KnowledgeGroundingOperationalMetrics> {
  const limit = Number.isSafeInteger(input.limit) && Number(input.limit) >= 1 &&
    Number(input.limit) <= METRICS_ROW_LIMIT ? Number(input.limit) : METRICS_ROW_LIMIT;
  const rows = await client.knowledgeGroundingResult.findMany({
    orderBy: { createdAt: "desc" },
    select: { evidence: true },
    take: limit,
    where: {
      evidence: { not: Prisma.AnyNull },
      version: {
        in: [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
          34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
          51, 52, 53, 54, 55, 56, 57]
      },
      ...(input.since ? { createdAt: { gte: input.since } } : {})
    }
  });
  return aggregateKnowledgeGroundingMetrics(rows.flatMap(({ evidence }) =>
    metricsEvidence(evidence) ? [evidence] : []));
}
