export const KNOWLEDGE_ANSWER_POLICY_VERSION = 1 as const;
export const KNOWLEDGE_FULL_CONTEXT_THRESHOLD_BASIS_POINTS = 7_000 as const;
export const KNOWLEDGE_MAXIMUM_SEARCHES_DEFAULT = 12 as const;
export const KNOWLEDGE_MAXIMUM_SEARCHES_MINIMUM = 1 as const;
export const KNOWLEDGE_MAXIMUM_SEARCHES_MAXIMUM = 32 as const;

export type KnowledgeAnswerPolicySnapshot = Readonly<{
  fullContextThresholdBasisPoints: typeof KNOWLEDGE_FULL_CONTEXT_THRESHOLD_BASIS_POINTS;
  maximumKnowledgeSearches: number;
  revision: number;
  version: typeof KNOWLEDGE_ANSWER_POLICY_VERSION;
}>;

export function knowledgeAnswerPolicySnapshot(input: Readonly<{
  maximumKnowledgeSearches: number;
  revision: number;
}>): KnowledgeAnswerPolicySnapshot {
  if (!Number.isSafeInteger(input.maximumKnowledgeSearches) ||
    input.maximumKnowledgeSearches < KNOWLEDGE_MAXIMUM_SEARCHES_MINIMUM ||
    input.maximumKnowledgeSearches > KNOWLEDGE_MAXIMUM_SEARCHES_MAXIMUM ||
    !Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new Error("knowledge_answer_policy_invalid");
  }
  return Object.freeze({
    fullContextThresholdBasisPoints: KNOWLEDGE_FULL_CONTEXT_THRESHOLD_BASIS_POINTS,
    maximumKnowledgeSearches: input.maximumKnowledgeSearches,
    revision: input.revision,
    version: KNOWLEDGE_ANSWER_POLICY_VERSION
  });
}

export const DEFAULT_KNOWLEDGE_ANSWER_POLICY = knowledgeAnswerPolicySnapshot({
  maximumKnowledgeSearches: KNOWLEDGE_MAXIMUM_SEARCHES_DEFAULT,
  revision: 1
});
