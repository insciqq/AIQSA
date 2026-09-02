import { describe, expect, it } from "vitest";
import { knowledgeGroundingProviderParams } from "./groundingProviderParams";

describe("Knowledge grounding provider-neutral params", () => {
  it("replaces accepted answer controls with the exact current stage controls", () => {
    const baseParams = {
      maxOutputTokens: 8_192,
      reasoningEffort: "low",
      temperature: 0.2
    };
    expect(knowledgeGroundingProviderParams({
      baseParams,
      operation: { maxOutputTokens: 2_048, reasoningEffort: "high" }
    })).toEqual({
      maxOutputTokens: 2_048,
      reasoningEffort: "high",
      temperature: 0.2
    });
    expect(knowledgeGroundingProviderParams({
      baseParams,
      operation: { maxOutputTokens: 1_024, reasoningEffort: null }
    })).toEqual({ maxOutputTokens: 1_024, temperature: 0.2 });
  });

  it("does not mutate the accepted provider params", () => {
    const baseParams = Object.freeze({ reasoningEffort: "medium" });
    knowledgeGroundingProviderParams({
      baseParams,
      operation: { maxOutputTokens: 1_024, reasoningEffort: "high" }
    });
    expect(baseParams).toEqual({ reasoningEffort: "medium" });
  });
});
