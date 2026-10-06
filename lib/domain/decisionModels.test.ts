import { describe, expect, it } from "vitest";
import { decodeDecisionFeatureOverrides } from "../contracts/semanticDecisions";
import { DEFAULT_DECISION_FEATURES, decisionFeatureEnabled } from "./decisionModels";

describe("optional Skill catalog decision policy", () => {
  it("preserves all historical feature overrides and defaults while the new consumer defaults off", () => {
    expect(DEFAULT_DECISION_FEATURES).toEqual(["knowledgeRelevance", "skillSuggestions"]);
    for (const feature of DEFAULT_DECISION_FEATURES) {
      expect(decisionFeatureEnabled({}, feature)).toBe(true);
      expect(decisionFeatureEnabled({ [feature]: false }, feature)).toBe(false);
    }
    const historical = { skillSuggestions: false, knowledgeRelevance: true };
    expect(decodeDecisionFeatureOverrides(historical)).toEqual(historical);
    expect(decisionFeatureEnabled(historical, "skillCatalogRelevance")).toBe(false);
    expect(decisionFeatureEnabled({}, "skillCatalogRelevance")).toBe(false);
    expect(decisionFeatureEnabled({}, "memoryControlScreen")).toBe(false);
    expect(decisionFeatureEnabled({ memoryControlScreen: true }, "memoryControlScreen")).toBe(true);
    expect(decisionFeatureEnabled({ ...historical, skillCatalogRelevance: true }, "skillCatalogRelevance")).toBe(true);
    expect(decodeDecisionFeatureOverrides({ ...historical, skillCatalogRelevance: false })).toEqual({ ...historical, skillCatalogRelevance: false });
  });
  it("drops retired toolDiscovery and memoryRelevance overrides instead of disabling every feature", () => {
    for (const stored of [{ toolDiscovery: false }, { toolDiscovery: "off", memoryRelevance: false, skillSuggestions: true }]) {
      const decoded = decodeDecisionFeatureOverrides(stored);
      expect(decoded).not.toBeNull();
      expect(decoded).not.toHaveProperty("toolDiscovery");
      expect(decoded).not.toHaveProperty("memoryRelevance");
      expect(decisionFeatureEnabled(stored, "knowledgeRelevance")).toBe(true);
      expect(decisionFeatureEnabled(stored, "skillSuggestions")).toBe(true);
    }
    expect(decisionFeatureEnabled({ toolDiscovery: false, knowledgeRelevance: false }, "knowledgeRelevance")).toBe(false);
  });
  it("keeps malformed and unknown persisted overrides invalid", () => {
    for (const input of [null, [], { skillCatalogRelevance: 1 }, { skillSuggestions: "false" }, { unknown: true }]) {
      expect(decodeDecisionFeatureOverrides(input)).toBeNull();
      expect(decisionFeatureEnabled(input, "skillCatalogRelevance")).toBe(false);
    }
  });
});
