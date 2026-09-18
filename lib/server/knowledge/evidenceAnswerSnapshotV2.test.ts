import { describe, expect, it } from "vitest";
import { createKnowledgeEvidenceAnswerSnapshotV2, decodeKnowledgeEvidenceAnswerSnapshotV2 } from "./evidenceAnswerSnapshotV2";
import { resolveKnowledgeGroundingExecutionPolicyV1 } from "./groundingExecutionPolicy";

const input = { operation: "knowledge_evidence_compose_v2" as const, workflowVersion: 11 as const,
  evidenceReceiptHash: "a".repeat(64), transport: "native_strict" as const,
  executionPolicy: resolveKnowledgeGroundingExecutionPolicyV1({ inheritedReasoningEffort: "high", modelCapabilities: {
    nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, vision: false } }),
  systemPrompt: "Compose a grounded answer.", userPrompt: "Provided evidence." };

describe("Knowledge generation admission", () => {
  it("retains legacy bytes and decodes model-aware budgets without silently changing either", () => {
    const legacy = createKnowledgeEvidenceAnswerSnapshotV2(input);
    expect(legacy.maxOutputTokens).toBe(8192);
    expect(legacy).not.toHaveProperty("reasoningBudgetIncluded");
    expect(decodeKnowledgeEvidenceAnswerSnapshotV2(legacy)).toEqual(legacy);
    const current = createKnowledgeEvidenceAnswerSnapshotV2({ ...input, generationBudget: {
      version: 1, contextWindow: 1_000_000, maxOutputTokens: 131_072, timeoutMs: 300_000 } });
    expect(current).toMatchObject({ maxOutputTokens: 131_072, reasoningBudgetIncluded: true, reasoningEffort: "high" });
    expect(decodeKnowledgeEvidenceAnswerSnapshotV2(current)).toEqual(current);
    expect(decodeKnowledgeEvidenceAnswerSnapshotV2({ ...current, maxOutputTokens: 8192 })).toBeNull();
  });

  it("fits the composed instructions and evidence in the admitted context, including recovery", () => {
    const current = createKnowledgeEvidenceAnswerSnapshotV2({ ...input, userPrompt: "x".repeat(20_000),
      answerInstructions: { system: "x".repeat(4_000), responseReminder: "Keep all units." },
      generationBudget: { version: 1, contextWindow: 10_000, maxOutputTokens: 8192, timeoutMs: 300_000 } });
    expect(current.maxOutputTokens).toBeLessThan(3_000);
    expect(decodeKnowledgeEvidenceAnswerSnapshotV2(current)).toEqual(current);
    expect(() => createKnowledgeEvidenceAnswerSnapshotV2({ ...input, userPrompt: "x".repeat(40_000),
      generationBudget: { version: 1, contextWindow: 10_000, maxOutputTokens: 8192, timeoutMs: 300_000 } }))
      .toThrow("provider_context_limit_exceeded");
  });
});
