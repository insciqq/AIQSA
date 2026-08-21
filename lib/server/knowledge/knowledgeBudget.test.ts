import { describe, expect, it } from "vitest";
import {
  DEFAULT_KNOWLEDGE_BUDGET_POLICY,
  decodeKnowledgeBudgetPolicy,
  isKnowledgeOperationKind,
  knowledgeBudgetStopReason,
  knowledgeBudgetPolicyFromProfileConfiguration,
  type KnowledgeBudgetUsage
} from "./knowledgeBudget";

function usage(overrides: Partial<KnowledgeBudgetUsage> = {}): KnowledgeBudgetUsage {
  return {
    cumulativeCandidates: 0,
    estimatedCostMicros: 0,
    latencyMs: 0,
    operations: 1,
    queryEmbeddingCalls: 0,
    retrievedTokens: 0,
    ...overrides
  };
}

describe("Knowledge execution budgets", () => {
  it("keeps the complete fixed policy and ignores historical profile overrides", () => {
    expect(decodeKnowledgeBudgetPolicy(DEFAULT_KNOWLEDGE_BUDGET_POLICY))
      .toEqual(DEFAULT_KNOWLEDGE_BUDGET_POLICY);
    expect(decodeKnowledgeBudgetPolicy({ maxOperations: 4 })).toBeNull();
    expect(knowledgeBudgetPolicyFromProfileConfiguration({
      executionBudgets: { maxOperations: 4 }
    })).toEqual(DEFAULT_KNOWLEDGE_BUDGET_POLICY);
  });

  it("allows four operations and embeddings without planner-era dimensions", () => {
    const policy = DEFAULT_KNOWLEDGE_BUDGET_POLICY;
    expect(policy).toMatchObject({
      maxCumulativeCandidates: 160,
      maxLatencyMs: 120_000,
      maxOperations: 4,
      maxQueryEmbeddingCalls: 4,
      maxRetrievedTokens: 49_152
    });
    expect(Object.hasOwn(policy, "maxRerankerCalls")).toBe(false);
    expect(Object.hasOwn(policy, "maxSearchPhases")).toBe(false);
    expect(knowledgeBudgetStopReason(policy, usage({ operations: 4 }))).toBeNull();
    expect(knowledgeBudgetStopReason(policy, usage({ operations: 5 })))
      .toBe("operation_budget");
    expect(knowledgeBudgetStopReason(policy, usage({ queryEmbeddingCalls: 4 }))).toBeNull();
    expect(knowledgeBudgetStopReason(policy, usage({ queryEmbeddingCalls: 5 })))
      .toBe("embedding_budget");
  });

  it("keeps the structural decoding ceiling separate from the default policy", () => {
    expect(decodeKnowledgeBudgetPolicy({
      ...DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      maxOperations: 256
    })?.maxOperations).toBe(256);
    expect(decodeKnowledgeBudgetPolicy({
      ...DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      maxOperations: 257
    })).toBeNull();
  });

  it("admits only the focused operation and separately authorized internal primitives", () => {
    expect(isKnowledgeOperationKind("structured_analysis")).toBe(false);
    expect(isKnowledgeOperationKind("visual_analysis")).toBe(false);
    expect(isKnowledgeOperationKind("automatic_search")).toBe(true);
    expect(isKnowledgeOperationKind("find_exact")).toBe(true);
    expect(isKnowledgeOperationKind("discover_sources")).toBe(true);
    expect(isKnowledgeOperationKind("read_source")).toBe(true);
  });
});
