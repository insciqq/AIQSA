import { Prisma, type PrismaClient } from "@prisma/client";
import type { KnowledgeAnswerSettlementV5 } from "./answerGroundingV5";

const groundingStages = Object.freeze([
  "primary",
  "initial",
  "repair",
  "auditor",
  "auditor_repair",
  "supplement",
  "final"
] as const);

type KnowledgeGroundingStage = typeof groundingStages[number];

type KnowledgeGroundingMetricsEvidence = Readonly<{
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
  coverage: Readonly<{ complete: number; none: number; partial: number }>;
  correctionAttempted: number;
  correctionSucceeded: number;
  draftClaims: number;
  modelOperations: number;
  pipelineVersion21: number;
  selectorContradicted: number;
  selectorSupported: number;
  selectorUnsupported: number;
  stages: Readonly<Record<KnowledgeGroundingStage, KnowledgeGroundingStageOperationalMetrics>>;
  totalCoverageDimensions: number;
  totalMissingCoverageDimensions: number;
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
  let totalMissingCoverageDimensions = 0;
  for (const evidence of evidences) {
    coverage[evidence.requestCoverage] += 1;
    correctionAttempted += Number(evidence.correctionAttempted);
    correctionSucceeded += Number(evidence.correctionSucceeded);
    draftClaims += evidence.draftClaimCount;
    selectorContradicted += evidence.contradictedClaimCount;
    selectorSupported += evidence.supportedClaimCount;
    selectorUnsupported += evidence.unsupportedClaimCount;
    totalCoverageDimensions += evidence.audit.dimensionCount;
    totalMissingCoverageDimensions += evidence.audit.missingDimensionCount;
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
    auditAccepted: evidences.length,
    coverage: Object.freeze(coverage),
    correctionAttempted,
    correctionSucceeded,
    draftClaims,
    modelOperations,
    pipelineVersion21: evidences.length,
    selectorContradicted,
    selectorSupported,
    selectorUnsupported,
    stages: Object.freeze(stages),
    totalCoverageDimensions,
    totalMissingCoverageDimensions
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
  if (!record(value) || value.version !== 18 || !record(value.audit) ||
    value.audit.status !== "accepted" || !counter(value.audit.dimensionCount) ||
    !counter(value.audit.missingDimensionCount) ||
    typeof value.correctionAttempted !== "boolean" ||
    typeof value.correctionSucceeded !== "boolean" ||
    !counter(value.draftClaimCount) || !counter(value.contradictedClaimCount) ||
    !counter(value.supportedClaimCount) || !counter(value.unsupportedClaimCount) ||
    value.requestCoverage !== "complete" && value.requestCoverage !== "none" &&
      value.requestCoverage !== "partial" || !Array.isArray(value.operations)) return false;
  return value.operations.length >= 3 && value.operations.length <= 6 &&
    value.operations.every((operation) => record(operation) &&
      groundingStages.includes(operation.role as KnowledgeGroundingStage) &&
      counter(operation.durationMs) && record(operation.usage) &&
      counter(operation.usage.inputTokens) && counter(operation.usage.outputTokens));
}

const METRICS_ROW_LIMIT = 10_000;

/** Loads only V18 content-free receipts; malformed rows are ignored. */
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
      version: 18,
      ...(input.since ? { createdAt: { gte: input.since } } : {})
    }
  });
  return aggregateKnowledgeGroundingMetrics(rows.flatMap(({ evidence }) =>
    metricsEvidence(evidence) ? [evidence] : []));
}
