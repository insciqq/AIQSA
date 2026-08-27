import { Prisma, type PrismaClient } from "@prisma/client";
import {
  decodeKnowledgeRerankerBindingEvidenceV2,
  type KnowledgeRerankerBindingEvidenceV2
} from "./rerankEvidence";
import { isKnowledgeRerankMalformedResponseCode } from "./rerankExecution";

/**
 * Content-free aggregate operational metrics over persisted hosted-rerank
 * execution evidence. No query text, passage text, or provider payloads are
 * ever read or exposed — only counters, durations, and usage totals.
 */
export type KnowledgeRerankOperationalMetrics = Readonly<{
  averageInputCandidates: number | null;
  /** Provider rerank requests actually attempted. */
  calls: number;
  complete: number;
  disabled: number;
  /** Degraded operations that used the deterministic weighted RRF fallback. */
  fallback: number;
  malformedResponse: number;
  operations: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  partial: number;
  timeout: number;
  totalSearchUnits: number;
  totalTokens: number;
}>;

/** Fallback reasons recorded before any provider request was dispatched. */
const NEVER_DISPATCHED_REASONS = Object.freeze(new Set([
  "reranker_model_absent",
  "reranker_model_unavailable"
]));

function attemptedCall(evidence: KnowledgeRerankerBindingEvidenceV2): boolean {
  if (evidence.status === "partial") return true;
  if (evidence.status === "complete") {
    return evidence.relevanceScores.some((score) => score !== null);
  }
  if (evidence.status !== "degraded") return false;
  return evidence.fallbackReason !== null &&
    !NEVER_DISPATCHED_REASONS.has(evidence.fallbackReason);
}

function percentile(sorted: readonly number[], ratio: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  );
  return sorted[index]!;
}

export function aggregateKnowledgeRerankMetrics(
  evidences: readonly KnowledgeRerankerBindingEvidenceV2[]
): KnowledgeRerankOperationalMetrics {
  let calls = 0;
  let complete = 0;
  let disabled = 0;
  let fallback = 0;
  let malformedResponse = 0;
  let partial = 0;
  let timeout = 0;
  let totalSearchUnits = 0;
  let totalTokens = 0;
  let candidateTotal = 0;
  const durations: number[] = [];
  for (const evidence of evidences) {
    switch (evidence.status) {
      case "complete":
        complete += 1;
        break;
      case "partial":
        partial += 1;
        break;
      case "disabled":
        disabled += 1;
        break;
      case "degraded":
        fallback += 1;
        if (evidence.timedOut) timeout += 1;
        if (evidence.fallbackReason !== null &&
          isKnowledgeRerankMalformedResponseCode(evidence.fallbackReason)) {
          malformedResponse += 1;
        }
        break;
    }
    if (attemptedCall(evidence)) {
      calls += 1;
      candidateTotal += evidence.inputCandidateCount;
      durations.push(evidence.durationMs);
    }
    totalSearchUnits += evidence.usage.searchUnits ?? 0;
    totalTokens += evidence.usage.totalTokens ?? 0;
  }
  durations.sort((left, right) => left - right);
  return Object.freeze({
    averageInputCandidates: calls > 0
      ? Math.round(candidateTotal / calls * 100) / 100
      : null,
    calls,
    complete,
    disabled,
    fallback,
    malformedResponse,
    operations: evidences.length,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    partial,
    timeout,
    totalSearchUnits,
    totalTokens
  });
}

const METRICS_ROW_LIMIT = 10_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Loads the content-free rerank metrics aggregate from persisted retrieval
 * receipts. Rows without hosted-rerank evidence (older receipts and
 * compositions without a reranker runtime) are ignored.
 */
export async function loadKnowledgeRerankOperationalMetrics(
  client: Pick<PrismaClient, "knowledgeRun">,
  input: Readonly<{ limit?: number; since?: Date }> = {}
): Promise<KnowledgeRerankOperationalMetrics> {
  const limit = Number.isSafeInteger(input.limit) &&
    Number(input.limit) >= 1 && Number(input.limit) <= METRICS_ROW_LIMIT
    ? Number(input.limit)
    : METRICS_ROW_LIMIT;
  const rows = await client.knowledgeRun.findMany({
    orderBy: { createdAt: "desc" },
    select: { readReceipt: true },
    take: limit,
    where: {
      operation: "automatic_search",
      readReceipt: { not: Prisma.AnyNull },
      ...(input.since ? { createdAt: { gte: input.since } } : {})
    }
  });
  const evidences = rows.flatMap((row) => {
    if (!record(row.readReceipt)) return [];
    const decoded = decodeKnowledgeRerankerBindingEvidenceV2(row.readReceipt.rerankerBinding);
    return decoded ? [decoded] : [];
  });
  return aggregateKnowledgeRerankMetrics(evidences);
}
