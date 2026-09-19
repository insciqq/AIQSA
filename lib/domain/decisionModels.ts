import { decodeDecisionFeatureOverrides, type DecisionFeature } from "../contracts/semanticDecisions";

/** Exact served identities verified for this deployment. A new upstream
 * revision needs its own qualification; accepting arbitrary suffixes would
 * silently change the meaning of calibrated decisions. */
export const JEV_MODEL_ID = "typesafe/jev-1.13";
export const JEV_SERVED_MODEL_ID = "typesafe/jev-1.13-20260917";

/** Consumers enter the default set only after their independent qualification.
 * Merely installing a capable model never enables an unqualified hypothesis. */
export const DEFAULT_DECISION_FEATURES: readonly DecisionFeature[] = ["memoryRelevance", "knowledgeRelevance", "toolDiscovery", "skillSuggestions"];

export function decisionFeatureEnabled(overrides: unknown, feature: DecisionFeature): boolean {
  const decoded = decodeDecisionFeatureOverrides(overrides);
  return decoded !== null && (decoded[feature] ?? DEFAULT_DECISION_FEATURES.includes(feature));
}

export function decisionResponseModelMatches(expected: string, actual: string): boolean {
  return actual === expected || expected === JEV_MODEL_ID && actual === JEV_SERVED_MODEL_ID;
}

export function jevModelConfiguration() {
  return {
    adapterKind: "openrouter_decisions" as const,
    answerSelectable: false,
    capabilities: {
      contextWindow: 32_000,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    modelClass: "decision" as const,
    openRouterRouting: { mode: "only_selected" as const, providers: ["typesafe"] },
    upstreamModelId: JEV_MODEL_ID
  };
}
