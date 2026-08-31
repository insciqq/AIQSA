import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_GROUNDING_EXECUTION_POLICY_V1,
  decodeKnowledgeGroundingEffectiveExecutionPolicyV1,
  resolveKnowledgeGroundingExecutionPolicyV1
} from "./groundingExecutionPolicy";

const capabilities = Object.freeze({
  nativePdfInput: false,
  nativeSearch: false,
  pdf: false,
  reasoning: true,
  reasoningEfforts: ["low", "medium", "high"],
  vision: false
});

describe("Knowledge grounding execution policy V1", () => {
  it("inherits the accepted answer effort by default without requiring reasoning", () => {
    expect(resolveKnowledgeGroundingExecutionPolicyV1({
      inheritedReasoningEffort: "low",
      modelCapabilities: { ...capabilities, reasoning: false, reasoningEfforts: undefined }
    })).toEqual({
      auditorReasoningEffort: "low",
      draftReasoningEffort: "low",
      egressDestination: "answer_provider",
      overriddenRoles: [],
      providerBindingKey: "answer",
      selectorReasoningEffort: "low",
      supplementReasoningEffort: "low",
      version: 1
    });
    expect(KNOWLEDGE_GROUNDING_EXECUTION_POLICY_V1)
      .toMatchObject({ auditorReasoningEffort: "inherit", version: 1 });
  });

  it("resolves only capability-backed installation overrides", () => {
    const effective = resolveKnowledgeGroundingExecutionPolicyV1({
      inheritedReasoningEffort: "low",
      modelCapabilities: capabilities,
      policy: {
        auditorReasoningEffort: "high",
        draftReasoningEffort: "inherit",
        selectorReasoningEffort: "medium",
        supplementReasoningEffort: "inherit",
        version: 1
      }
    });
    expect(effective).toMatchObject({
      auditorReasoningEffort: "high",
      draftReasoningEffort: "low",
      overriddenRoles: ["selector", "auditor"],
      selectorReasoningEffort: "medium",
      supplementReasoningEffort: "low"
    });
    expect(decodeKnowledgeGroundingEffectiveExecutionPolicyV1(effective)).toEqual(effective);
  });

  it("fails closed on malformed or unavailable overrides", () => {
    expect(() => resolveKnowledgeGroundingExecutionPolicyV1({
      inheritedReasoningEffort: "low",
      modelCapabilities: capabilities,
      policy: {
        ...KNOWLEDGE_GROUNDING_EXECUTION_POLICY_V1,
        auditorReasoningEffort: "ultra"
      }
    })).toThrow("knowledge_grounding_execution_policy_unsupported");
    expect(() => resolveKnowledgeGroundingExecutionPolicyV1({
      inheritedReasoningEffort: "low",
      modelCapabilities: capabilities,
      policy: {
        ...KNOWLEDGE_GROUNDING_EXECUTION_POLICY_V1,
        version: 2
      } as never
    })).toThrow("knowledge_grounding_execution_policy_invalid");
    expect(decodeKnowledgeGroundingEffectiveExecutionPolicyV1({
      auditorReasoningEffort: "private prompt",
      draftReasoningEffort: "low",
      egressDestination: "other_provider",
      overriddenRoles: [],
      providerBindingKey: "answer",
      selectorReasoningEffort: "low",
      supplementReasoningEffort: "low",
      version: 1
    })).toBeNull();
  });
});
