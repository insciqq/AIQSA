export const DECISION_FEATURES = ["memoryRelevance", "knowledgeRelevance", "toolDiscovery", "skillSuggestions", "skillCatalogRelevance"] as const;
export type DecisionFeature = typeof DECISION_FEATURES[number];
export type DecisionFeatureOverrides = Partial<Record<DecisionFeature, boolean>>;

export function decodeDecisionFeatureOverrides(value: unknown): DecisionFeatureOverrides | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.entries(value).some(([key, enabled]) =>
    !(DECISION_FEATURES as readonly string[]).includes(key) || typeof enabled !== "boolean")) return null;
  return { ...value } as DecisionFeatureOverrides;
}
