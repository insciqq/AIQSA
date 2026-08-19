export const KNOWLEDGE_BUDGET_POLICY_VERSION = 1 as const;

export const knowledgeOperationKinds = [
  "automatic_search",
  "discover_sources",
  "find_exact",
  "read_source",
  "search_knowledge"
] as const;

export type KnowledgeOperationKind = typeof knowledgeOperationKinds[number];

export const knowledgeBudgetStopReasons = [
  "candidate_budget",
  "cost_budget",
  "embedding_budget",
  "follow_up_budget",
  "latency_budget",
  "low_novelty",
  "operation_budget",
  "phase_budget",
  "reranker_budget",
  "retrieved_token_budget",
  "subquery_budget"
] as const;

export type KnowledgeBudgetStopReason = typeof knowledgeBudgetStopReasons[number];

/**
 * Internal execution policy. It is snapshotted with an admitted run and is
 * deliberately absent from ordinary user/API settings.
 */
export type KnowledgeBudgetPolicy = Readonly<{
  estimatedEmbeddingCostMicrosPerThousandTokens: number;
  maxConsecutiveLowNoveltyOperations: number;
  maxCumulativeCandidates: number;
  maxEstimatedCostMicros: number;
  maxFollowUpOperations: number;
  maxLatencyMs: number;
  maxOperations: number;
  maxQueryEmbeddingCalls: number;
  maxRerankerCalls: number;
  maxRetrievedTokens: number;
  maxSearchPhases: number;
  maxSubqueriesPerPhase: number;
  minNoveltyRatio: number;
  version: typeof KNOWLEDGE_BUDGET_POLICY_VERSION;
}>;

export type KnowledgeBudgetUsage = Readonly<{
  cumulativeCandidates: number;
  estimatedCostMicros: number;
  followUpOperations: number;
  latencyMs: number;
  lowNoveltyStreak: number;
  operations: number;
  queryEmbeddingCalls: number;
  rerankerCalls: number;
  retrievedTokens: number;
  searchPhases: number;
  subqueriesInCurrentPhase: number;
}>;

export type KnowledgeBudgetEvidence = Readonly<{
  noveltyRatio: number | null;
  operation: KnowledgeOperationKind;
  stopReason: KnowledgeBudgetStopReason | null;
  usage: KnowledgeBudgetUsage;
  version: typeof KNOWLEDGE_BUDGET_POLICY_VERSION;
}>;

export const DEFAULT_KNOWLEDGE_BUDGET_POLICY: KnowledgeBudgetPolicy = Object.freeze({
  estimatedEmbeddingCostMicrosPerThousandTokens: 100,
  maxConsecutiveLowNoveltyOperations: 2,
  maxCumulativeCandidates: 1_400,
  maxEstimatedCostMicros: 10_000,
  maxFollowUpOperations: 6,
  maxLatencyMs: 30_000,
  maxOperations: 14,
  maxQueryEmbeddingCalls: 14,
  maxRerankerCalls: 14,
  maxRetrievedTokens: 32_000,
  maxSearchPhases: 4,
  maxSubqueriesPerPhase: 8,
  minNoveltyRatio: 0.1,
  version: KNOWLEDGE_BUDGET_POLICY_VERSION
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function decodeKnowledgeBudgetPolicy(value: unknown): KnowledgeBudgetPolicy | null {
  if (!record(value)) return null;
  const keys = [
    "estimatedEmbeddingCostMicrosPerThousandTokens",
    "maxConsecutiveLowNoveltyOperations",
    "maxCumulativeCandidates",
    "maxEstimatedCostMicros",
    "maxFollowUpOperations",
    "maxLatencyMs",
    "maxOperations",
    "maxQueryEmbeddingCalls",
    "maxRerankerCalls",
    "maxRetrievedTokens",
    "maxSearchPhases",
    "maxSubqueriesPerPhase",
    "minNoveltyRatio",
    "version"
  ] as const;
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
    value.version !== KNOWLEDGE_BUDGET_POLICY_VERSION ||
    !integer(value.estimatedEmbeddingCostMicrosPerThousandTokens, 0, 1_000_000) ||
    !integer(value.maxConsecutiveLowNoveltyOperations, 1, 32) ||
    !integer(value.maxCumulativeCandidates, 1, 1_000_000) ||
    !integer(value.maxEstimatedCostMicros, 0, 1_000_000_000) ||
    !integer(value.maxFollowUpOperations, 0, 128) ||
    !integer(value.maxLatencyMs, 100, 3_600_000) ||
    !integer(value.maxOperations, 1, 256) ||
    !integer(value.maxQueryEmbeddingCalls, 0, 256) ||
    !integer(value.maxRerankerCalls, 0, 256) ||
    !integer(value.maxRetrievedTokens, 1, 10_000_000) ||
    !integer(value.maxSearchPhases, 1, 64) ||
    !integer(value.maxSubqueriesPerPhase, 1, 128) ||
    !finite(value.minNoveltyRatio, 0, 1) ||
    value.maxFollowUpOperations > value.maxOperations ||
    value.maxSearchPhases > value.maxOperations ||
    value.maxSubqueriesPerPhase > value.maxOperations) return null;
  return Object.freeze({
    estimatedEmbeddingCostMicrosPerThousandTokens:
      Number(value.estimatedEmbeddingCostMicrosPerThousandTokens),
    maxConsecutiveLowNoveltyOperations: Number(value.maxConsecutiveLowNoveltyOperations),
    maxCumulativeCandidates: Number(value.maxCumulativeCandidates),
    maxEstimatedCostMicros: Number(value.maxEstimatedCostMicros),
    maxFollowUpOperations: Number(value.maxFollowUpOperations),
    maxLatencyMs: Number(value.maxLatencyMs),
    maxOperations: Number(value.maxOperations),
    maxQueryEmbeddingCalls: Number(value.maxQueryEmbeddingCalls),
    maxRerankerCalls: Number(value.maxRerankerCalls),
    maxRetrievedTokens: Number(value.maxRetrievedTokens),
    maxSearchPhases: Number(value.maxSearchPhases),
    maxSubqueriesPerPhase: Number(value.maxSubqueriesPerPhase),
    minNoveltyRatio: Number(value.minNoveltyRatio),
    version: KNOWLEDGE_BUDGET_POLICY_VERSION
  });
}

export function knowledgeBudgetPolicyFromProfileConfiguration(
  value: unknown
): KnowledgeBudgetPolicy {
  if (!record(value) || value.executionBudgets === undefined) {
    return DEFAULT_KNOWLEDGE_BUDGET_POLICY;
  }
  const decoded = decodeKnowledgeBudgetPolicy(value.executionBudgets);
  if (!decoded) throw new Error("knowledge_budget_policy_invalid");
  return decoded;
}

export function isKnowledgeOperationKind(value: unknown): value is KnowledgeOperationKind {
  return typeof value === "string" &&
    knowledgeOperationKinds.includes(value as KnowledgeOperationKind);
}

export function knowledgeBudgetStopReason(
  policy: KnowledgeBudgetPolicy,
  usage: KnowledgeBudgetUsage
): KnowledgeBudgetStopReason | null {
  if (usage.searchPhases > policy.maxSearchPhases) return "phase_budget";
  if (usage.subqueriesInCurrentPhase > policy.maxSubqueriesPerPhase) return "subquery_budget";
  if (usage.operations > policy.maxOperations) return "operation_budget";
  if (usage.followUpOperations > policy.maxFollowUpOperations) return "follow_up_budget";
  if (usage.cumulativeCandidates >= policy.maxCumulativeCandidates) return "candidate_budget";
  if (usage.rerankerCalls >= policy.maxRerankerCalls) return "reranker_budget";
  if (usage.queryEmbeddingCalls >= policy.maxQueryEmbeddingCalls) return "embedding_budget";
  if (usage.retrievedTokens >= policy.maxRetrievedTokens) return "retrieved_token_budget";
  if (usage.latencyMs >= policy.maxLatencyMs) return "latency_budget";
  if (usage.estimatedCostMicros >= policy.maxEstimatedCostMicros) return "cost_budget";
  if (usage.lowNoveltyStreak >= policy.maxConsecutiveLowNoveltyOperations) return "low_novelty";
  return null;
}

export function estimatedKnowledgeEmbeddingCostMicros(
  policy: KnowledgeBudgetPolicy,
  tokens: number
): number {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return 0;
  return Math.ceil(tokens * policy.estimatedEmbeddingCostMicrosPerThousandTokens / 1_000);
}
