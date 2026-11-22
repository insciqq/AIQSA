export const DECISION_FEATURES = ["memoryControlScreen", "skillSuggestions", "skillCatalogRelevance"] as const;
export type DecisionFeature = typeof DECISION_FEATURES[number];
export type DecisionFeatureOverrides = Partial<Record<DecisionFeature, boolean>>;

/** Overrides name only current features: v0.5.0 removed the retired ones (MCP tool discovery, Memory relevance,
 * Knowledge relevance) from the stored overrides, and the administrator's page sends only what the server listed. */
export function decodeDecisionFeatureOverrides(value: unknown): DecisionFeatureOverrides | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([key, enabled]) =>
    !(DECISION_FEATURES as readonly string[]).includes(key) || typeof enabled !== "boolean")) return null;
  return Object.fromEntries(entries) as DecisionFeatureOverrides;
}
