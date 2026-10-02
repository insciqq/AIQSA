export const DECISION_FEATURES = ["memoryRelevance", "memoryControlScreen", "knowledgeRelevance", "skillSuggestions", "skillCatalogRelevance"] as const;
export type DecisionFeature = typeof DECISION_FEATURES[number];
export type DecisionFeatureOverrides = Partial<Record<DecisionFeature, boolean>>;

/** Retired features: MCP tool discovery became local search. Stored or
 * submitted overrides for them are dropped, never a reason to reject the rest. */
const RETIRED_DECISION_FEATURES: ReadonlySet<string> = new Set(["toolDiscovery"]);

export function decodeDecisionFeatureOverrides(value: unknown): DecisionFeatureOverrides | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(([key]) => !RETIRED_DECISION_FEATURES.has(key));
  if (entries.some(([key, enabled]) =>
    !(DECISION_FEATURES as readonly string[]).includes(key) || typeof enabled !== "boolean")) return null;
  return Object.fromEntries(entries) as DecisionFeatureOverrides;
}
