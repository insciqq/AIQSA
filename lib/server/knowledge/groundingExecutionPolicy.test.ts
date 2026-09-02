import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_GROUNDING_EXECUTION_POLICY_V1,
  decodeKnowledgeGroundingEffectiveExecutionPolicyV1,
  knowledgeGroundingInheritedReasoningEffortV1,
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

  it("uses the frozen provider-neutral effort and decodes historical dialects", () => {
    expect(knowledgeGroundingInheritedReasoningEffortV1({
      acceptedReasoningEffort: "medium",
      params: { reasoning: { effort: "low" } }
    })).toBe("medium");
    expect(knowledgeGroundingInheritedReasoningEffortV1({
      params: { reasoning: { effort: "medium" } }
    })).toBe("medium");
    expect(knowledgeGroundingInheritedReasoningEffortV1({
      params: {
        reasoning: { effort: "low", enabled: true },
        verbosity: "high"
      }
    })).toBe("high");
    expect(knowledgeGroundingInheritedReasoningEffortV1({
      params: { reasoning: { effort: "high", enabled: false } }
    })).toBeNull();
  });

  it("fails closed on malformed or conflicting historical reasoning controls", () => {
    expect(() => knowledgeGroundingInheritedReasoningEffortV1({
      acceptedReasoningEffort: " bad ",
      params: {}
    })).toThrow("knowledge_grounding_reasoning_control_invalid");
    expect(() => knowledgeGroundingInheritedReasoningEffortV1({
      params: {
        outputConfig: { effort: "high" },
        reasoning: { effort: "low" }
      }
    })).toThrow("knowledge_grounding_reasoning_control_invalid");
  });
});
