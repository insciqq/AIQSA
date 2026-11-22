import { describe, expect, it } from "vitest";
import { decodeDecisionFeatureOverrides } from "../contracts/semanticDecisions";
import { DEFAULT_DECISION_FEATURES, decisionFeatureEnabled } from "./decisionModels";

describe("optional Skill catalog decision policy", () => {
  it("preserves all historical feature overrides and defaults while the new consumer defaults off", () => {
    expect(DEFAULT_DECISION_FEATURES).toEqual(["skillSuggestions"]);
    for (const feature of DEFAULT_DECISION_FEATURES) {
      expect(decisionFeatureEnabled({}, feature)).toBe(true);
      expect(decisionFeatureEnabled({ [feature]: false }, feature)).toBe(false);
    }
    const historical = { skillSuggestions: false, memoryControlScreen: true };
    expect(decodeDecisionFeatureOverrides(historical)).toEqual(historical);
    expect(decisionFeatureEnabled(historical, "skillCatalogRelevance")).toBe(false);
    expect(decisionFeatureEnabled({}, "skillCatalogRelevance")).toBe(false);
    expect(decisionFeatureEnabled({}, "memoryControlScreen")).toBe(false);
    expect(decisionFeatureEnabled({ memoryControlScreen: true }, "memoryControlScreen")).toBe(true);
    expect(decisionFeatureEnabled({ ...historical, skillCatalogRelevance: true }, "skillCatalogRelevance")).toBe(true);
    expect(decodeDecisionFeatureOverrides({ ...historical, skillCatalogRelevance: false })).toEqual({ ...historical, skillCatalogRelevance: false });
  });
  it("refuses the retired toolDiscovery, memoryRelevance and knowledgeRelevance overrides the upgrade removed", () => {
    for (const stored of [{ toolDiscovery: false }, { memoryRelevance: false, skillSuggestions: true }, { knowledgeRelevance: false }]) {
      expect(decodeDecisionFeatureOverrides(stored)).toBeNull();
    }
  });
  it("keeps malformed and unknown persisted overrides invalid", () => {
    for (const input of [null, [], { skillCatalogRelevance: 1 }, { skillSuggestions: "false" }, { unknown: true }]) {
      expect(decodeDecisionFeatureOverrides(input)).toBeNull();
      expect(decisionFeatureEnabled(input, "skillCatalogRelevance")).toBe(false);
    }
  });
});
