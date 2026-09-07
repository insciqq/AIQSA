import {
  percentile,
  recallAtK,
  type KnowledgeQueryOutcome
} from "./contract";
import {
  createKnowledgeFocusedRequest,
  KNOWLEDGE_FOCUSED_QUERY_MAX_CHARACTERS
} from "../../lib/server/knowledge/focusedRequest";
import type { KnowledgeBenchmarkQuery } from "./contract";
import {
  decodeBrightPreparedEvaluationQueryRow,
  decodeBrightPreparedRuntimeQueryRow
} from "./brightStackOverflowContract";

export type BrightRetrievalQuerySet = Readonly<{
  boundedQueryCount: number;
  normalizedQueryCount: number;
  queries: readonly KnowledgeBenchmarkQuery[];
}>;

type BrightMetricOutcome = KnowledgeQueryOutcome & Readonly<{
  rerankerDiagnostic: Readonly<{
    fallbackReason: string | null;
    timedOut: boolean;
  }>;
}>;

export type BrightRetrievalMetrics = Readonly<{
  attemptAccountingComplete: boolean;
  classifiedFailureCounts: Readonly<Record<string, number>>;
  finalResultLimit: number;
  queryFailureCount: number | null;
  recall10: number;
  recall5: number;
  recallFinal: number;
  rerankMsP99: number | null;
  retryCount: number | null;
  retrievalMsP99: number;
  success10: number;
  success5: number;
  successFinal: number;
  timeoutCount: number | null;
}>;

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function successAtK(outcome: KnowledgeQueryOutcome, k: number): number {
  return outcome.rankedDocumentIds.slice(0, k).some(
    (documentId) => (outcome.relevant[documentId] ?? 0) > 0
  ) ? 1 : 0;
}

/** BRIGHT-specific secondary metrics. A complete runner currently performs no
 * whole-query retries: provider rerank fallbacks are classified separately and
 * a query-embedding/database/invariant failure stops the scoreable run.
 * Existing resumed checkpoints do not contain failed attempt receipts; their
 * whole-query counters must be unknown, not silently reset to zero. */
export function aggregateBrightRetrievalMetrics(
  outcomes: readonly BrightMetricOutcome[],
  finalResultLimit: number,
  attemptAccountingComplete = true
): BrightRetrievalMetrics {
  if (outcomes.length === 0 || !Number.isSafeInteger(finalResultLimit) ||
    finalResultLimit < 1 || finalResultLimit > 10_000) {
    throw new Error("bright_stackoverflow_retrieval_metrics_invalid");
  }
  const failureCounts = new Map<string, number>();
  for (const outcome of outcomes) {
    const reason = outcome.rerankerDiagnostic.fallbackReason;
    if (reason) failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + 1);
  }
  const rerankDurations = outcomes
    .map(({ rerankMs }) => rerankMs)
    .filter((value): value is number => value !== null);
  return Object.freeze({
    attemptAccountingComplete,
    classifiedFailureCounts: Object.freeze(Object.fromEntries(
      [...failureCounts].sort(([left], [right]) => left.localeCompare(right))
    )),
    finalResultLimit,
    queryFailureCount: attemptAccountingComplete ? 0 : null,
    recall10: mean(outcomes.map((outcome) =>
      recallAtK(outcome.rankedDocumentIds, outcome.relevant, 10))),
    recall5: mean(outcomes.map((outcome) =>
      recallAtK(outcome.rankedDocumentIds, outcome.relevant, 5))),
    recallFinal: mean(outcomes.map((outcome) =>
      recallAtK(outcome.rankedDocumentIds, outcome.relevant, finalResultLimit))),
    rerankMsP99: rerankDurations.length === 0
      ? null
      : percentile(rerankDurations, 99),
    retryCount: attemptAccountingComplete ? 0 : null,
    retrievalMsP99: percentile(outcomes.map(({ retrievalMs }) => retrievalMs), 99),
    success10: mean(outcomes.map((outcome) => successAtK(outcome, 10))),
    success5: mean(outcomes.map((outcome) => successAtK(outcome, 5))),
    successFinal: mean(outcomes.map((outcome) =>
      successAtK(outcome, finalResultLimit))),
    timeoutCount: attemptAccountingComplete ? outcomes.filter(
      ({ rerankerDiagnostic }) => rerankerDiagnostic.timedOut
    ).length : null
  });
}

export function buildBrightRetrievalQueries(
  runtimeRows: readonly unknown[],
  evaluatorRows: readonly unknown[]
): BrightRetrievalQuerySet {
  if (runtimeRows.length < 1 || runtimeRows.length !== evaluatorRows.length) {
    throw new Error("bright_stackoverflow_retrieval_query_count_mismatch");
  }
  const runtime = runtimeRows.map(decodeBrightPreparedRuntimeQueryRow);
  const evaluator = evaluatorRows.map(decodeBrightPreparedEvaluationQueryRow);
  if (new Set(runtime.map(({ officialId }) => officialId)).size !== runtime.length ||
    new Set(evaluator.map(({ officialId }) => officialId)).size !== evaluator.length) {
    throw new Error("bright_stackoverflow_retrieval_query_id_duplicate");
  }
  const evaluatorById = new Map(evaluator.map((query) => [query.officialId, query]));
  let boundedQueryCount = 0;
  let normalizedQueryCount = 0;
  const queries = runtime.map((query) => {
    const labels = evaluatorById.get(query.officialId);
    if (!labels) {
      throw new Error("bright_stackoverflow_retrieval_query_mapping_mismatch");
    }
    const focused = createKnowledgeFocusedRequest({
      currentUserMessage: query.text
    });
    if (!focused) throw new Error("bright_stackoverflow_retrieval_query_invalid");
    if ([...query.text].length > KNOWLEDGE_FOCUSED_QUERY_MAX_CHARACTERS) {
      boundedQueryCount += 1;
    }
    if (focused.retrievalQuery !== query.text) normalizedQueryCount += 1;
    return Object.freeze({
      excludedDocumentIds: labels.excludedIds,
      officialId: query.officialId,
      relevant: Object.freeze(Object.fromEntries(
        labels.goldIds.map((officialId) => [officialId, 1])
      )),
      text: focused.retrievalQuery
    });
  });
  if (evaluatorById.size !== queries.length) {
    throw new Error("bright_stackoverflow_retrieval_query_mapping_mismatch");
  }
  return Object.freeze({
    boundedQueryCount,
    normalizedQueryCount,
    queries: Object.freeze(queries)
  });
}
