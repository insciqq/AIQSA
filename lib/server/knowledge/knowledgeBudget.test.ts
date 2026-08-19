import { describe, expect, it } from "vitest";
import {
  DEFAULT_KNOWLEDGE_BUDGET_POLICY,
  decodeKnowledgeBudgetPolicy,
  knowledgeBudgetStopReason,
  knowledgeBudgetPolicyFromProfileConfiguration,
  type KnowledgeBudgetUsage
} from "./knowledgeBudget";

function usage(overrides: Partial<KnowledgeBudgetUsage> = {}): KnowledgeBudgetUsage {
  return {
    cumulativeCandidates: 0,
    estimatedCostMicros: 0,
    followUpOperations: 0,
    latencyMs: 0,
    lowNoveltyStreak: 0,
    operations: 1,
    queryEmbeddingCalls: 0,
    rerankerCalls: 0,
    retrievedTokens: 0,
    searchPhases: 1,
    subqueriesInCurrentPhase: 1,
    ...overrides
  };
}

describe("Knowledge execution budgets", () => {
  it("accepts the complete internal profile policy and rejects partial tuning objects", () => {
    expect(decodeKnowledgeBudgetPolicy(DEFAULT_KNOWLEDGE_BUDGET_POLICY))
      .toEqual(DEFAULT_KNOWLEDGE_BUDGET_POLICY);
    expect(decodeKnowledgeBudgetPolicy({ maxOperations: 4 })).toBeNull();
    expect(() => knowledgeBudgetPolicyFromProfileConfiguration({
      executionBudgets: { maxOperations: 4 }
    })).toThrow("knowledge_budget_policy_invalid");
  });

  it("stops on persisted multidimensional boundaries instead of a fixed call count", () => {
    const policy = { ...DEFAULT_KNOWLEDGE_BUDGET_POLICY, maxOperations: 9 };
    expect(knowledgeBudgetStopReason(policy, usage({ operations: 9 }))).toBeNull();
    expect(knowledgeBudgetStopReason(policy, usage({ operations: 10 })))
      .toBe("operation_budget");
    expect(knowledgeBudgetStopReason(policy, usage({
      operations: 4,
      retrievedTokens: policy.maxRetrievedTokens
    }))).toBe("retrieved_token_budget");
  });

  it("stops repeated low-novelty follow-ups even while other budgets remain", () => {
    expect(knowledgeBudgetStopReason(DEFAULT_KNOWLEDGE_BUDGET_POLICY, usage({
      lowNoveltyStreak: DEFAULT_KNOWLEDGE_BUDGET_POLICY.maxConsecutiveLowNoveltyOperations,
      operations: 4
    }))).toBe("low_novelty");
  });
});
