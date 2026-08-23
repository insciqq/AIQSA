export const KNOWLEDGE_BUDGET_POLICY_VERSION = 1 as const;

export const knowledgeOperationKinds = [
  "automatic_search",
  "discover_sources",
  "find_exact",
  "read_source"
] as const;

export type KnowledgeOperationKind = typeof knowledgeOperationKinds[number];

export const knowledgeBudgetStopReasons = [
  "candidate_budget",
  "cost_budget",
  "embedding_budget",
  "latency_budget",
  "operation_budget",
  "retrieved_token_budget"
] as const;

export type KnowledgeBudgetStopReason = typeof knowledgeBudgetStopReasons[number];

/**
 * Internal execution policy. It is snapshotted with an admitted run and is
 * deliberately absent from ordinary user/API settings.
 */
export type KnowledgeBudgetPolicy = Readonly<{
  estimatedEmbeddingCostMicrosPerThousandTokens: number;
  maxCumulativeCandidates: number;
  maxEstimatedCostMicros: number;
  maxLatencyMs: number;
  maxOperations: number;
  maxQueryEmbeddingCalls: number;
  maxRetrievedTokens: number;
  version: typeof KNOWLEDGE_BUDGET_POLICY_VERSION;
}>;

export type KnowledgeBudgetUsage = Readonly<{
  cumulativeCandidates: number;
  estimatedCostMicros: number;
  latencyMs: number;
  operations: number;
  queryEmbeddingCalls: number;
  retrievedTokens: number;
}>;

export type KnowledgeBudgetEvidence = Readonly<{
  operation: KnowledgeOperationKind;
  stopReason: KnowledgeBudgetStopReason | null;
  usage: KnowledgeBudgetUsage;
  version: typeof KNOWLEDGE_BUDGET_POLICY_VERSION;
}>;

/** Immutable planner-era receipt compatibility; never emitted by current runs. */
export type LegacyKnowledgeBudgetUsage = KnowledgeBudgetUsage & Readonly<{
  followUpOperations: number;
  lowNoveltyStreak: number;
  rerankerCalls: number;
  searchPhases: number;
  subqueriesInCurrentPhase: number;
}>;

/** Immutable planner-era receipt compatibility; never emitted by current runs. */
export type LegacyKnowledgeBudgetEvidence = Readonly<{
  noveltyRatio: number | null;
  operation: KnowledgeOperationKind;
  stopReason:
    | KnowledgeBudgetStopReason
    | "follow_up_budget"
    | "low_novelty"
    | "phase_budget"
    | "reranker_budget"
    | "subquery_budget"
    | null;
  usage: LegacyKnowledgeBudgetUsage;
  version: typeof KNOWLEDGE_BUDGET_POLICY_VERSION;
}>;

export const DEFAULT_KNOWLEDGE_BUDGET_POLICY: KnowledgeBudgetPolicy = Object.freeze({
  estimatedEmbeddingCostMicrosPerThousandTokens: 100,
  maxCumulativeCandidates: 480,
  maxEstimatedCostMicros: 30_000,
  maxLatencyMs: 360_000,
  maxOperations: 12,
  maxQueryEmbeddingCalls: 12,
  maxRetrievedTokens: 147_456,
  version: KNOWLEDGE_BUDGET_POLICY_VERSION
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

export function decodeKnowledgeBudgetPolicy(value: unknown): KnowledgeBudgetPolicy | null {
  if (!record(value)) return null;
  const keys = [
    "estimatedEmbeddingCostMicrosPerThousandTokens",
    "maxCumulativeCandidates",
    "maxEstimatedCostMicros",
    "maxLatencyMs",
    "maxOperations",
    "maxQueryEmbeddingCalls",
    "maxRetrievedTokens",
    "version"
  ] as const;
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
    value.version !== KNOWLEDGE_BUDGET_POLICY_VERSION ||
    !integer(value.estimatedEmbeddingCostMicrosPerThousandTokens, 0, 1_000_000) ||
    !integer(value.maxCumulativeCandidates, 1, 1_000_000) ||
    !integer(value.maxEstimatedCostMicros, 0, 1_000_000_000) ||
    !integer(value.maxLatencyMs, 100, 3_600_000) ||
    !integer(value.maxOperations, 1, 256) ||
    !integer(value.maxQueryEmbeddingCalls, 0, 256) ||
    !integer(value.maxRetrievedTokens, 1, 10_000_000)) return null;
  return Object.freeze({
    estimatedEmbeddingCostMicrosPerThousandTokens:
      Number(value.estimatedEmbeddingCostMicrosPerThousandTokens),
    maxCumulativeCandidates: Number(value.maxCumulativeCandidates),
    maxEstimatedCostMicros: Number(value.maxEstimatedCostMicros),
    maxLatencyMs: Number(value.maxLatencyMs),
    maxOperations: Number(value.maxOperations),
    maxQueryEmbeddingCalls: Number(value.maxQueryEmbeddingCalls),
    maxRetrievedTokens: Number(value.maxRetrievedTokens),
    version: KNOWLEDGE_BUDGET_POLICY_VERSION
  });
}

export function knowledgeBudgetPolicyFromProfileConfiguration(
  value: unknown,
  maximumKnowledgeSearches = DEFAULT_KNOWLEDGE_BUDGET_POLICY.maxOperations
): KnowledgeBudgetPolicy {
  // Immutable historical profiles may still contain wider planner-era
  // budgets. They are decode-only and never override the fixed focused path.
  void value;
  if (!integer(maximumKnowledgeSearches, 1, 32)) {
    throw new Error("knowledge_answer_policy_invalid");
  }
  return Object.freeze({
    estimatedEmbeddingCostMicrosPerThousandTokens:
      DEFAULT_KNOWLEDGE_BUDGET_POLICY.estimatedEmbeddingCostMicrosPerThousandTokens,
    maxCumulativeCandidates: maximumKnowledgeSearches * 40,
    maxEstimatedCostMicros: maximumKnowledgeSearches * 2_500,
    maxLatencyMs: maximumKnowledgeSearches * 30_000,
    maxOperations: maximumKnowledgeSearches,
    maxQueryEmbeddingCalls: maximumKnowledgeSearches,
    maxRetrievedTokens: maximumKnowledgeSearches * 12_288,
    version: KNOWLEDGE_BUDGET_POLICY_VERSION
  });
}

export function isKnowledgeOperationKind(value: unknown): value is KnowledgeOperationKind {
  return typeof value === "string" &&
    knowledgeOperationKinds.includes(value as KnowledgeOperationKind);
}

export function knowledgeBudgetStopReason(
  policy: KnowledgeBudgetPolicy,
  usage: KnowledgeBudgetUsage
): KnowledgeBudgetStopReason | null {
  if (usage.operations > policy.maxOperations) return "operation_budget";
  if (usage.cumulativeCandidates > policy.maxCumulativeCandidates) return "candidate_budget";
  if (usage.queryEmbeddingCalls > policy.maxQueryEmbeddingCalls) return "embedding_budget";
  if (usage.retrievedTokens > policy.maxRetrievedTokens) return "retrieved_token_budget";
  if (usage.latencyMs > policy.maxLatencyMs) return "latency_budget";
  if (usage.estimatedCostMicros > policy.maxEstimatedCostMicros) return "cost_budget";
  return null;
}

export function estimatedKnowledgeEmbeddingCostMicros(
  policy: KnowledgeBudgetPolicy,
  tokens: number
): number {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return 0;
  return Math.ceil(tokens * policy.estimatedEmbeddingCostMicrosPerThousandTokens / 1_000);
}
