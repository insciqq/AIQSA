export type RerankerModelPreset = Readonly<{
  automaticRoutePosition: number | null;
  default: boolean;
  description: string;
  displayName: string;
  id:
    | "cohere-rerank-4-pro"
    | "qwen3-reranker-0.6b"
    | "qwen3-reranker-4b"
    | "qwen3-reranker-8b"
    | "voyage-rerank-2.5";
  providerFamily: "openrouter";
  relevanceScoreFloor: number | null;
  upstreamModelId: string;
}>;

export const RERANKER_ROUTE_POLICY_VERSION = "openrouter-reranker-route-v1" as const;
export const DEFAULT_RERANKER_MODEL_PRESET_ID = "voyage-rerank-2.5" as const;
export const RERANKER_RESPONSE_TIMEOUT_MS = 5_000;

export const rerankerModelPresets: readonly RerankerModelPreset[] = Object.freeze([
  {
    automaticRoutePosition: 0,
    default: true,
    description: "Provisional accuracy-first multilingual default for Memory evidence ordering.",
    displayName: "Voyage Rerank 2.5",
    id: DEFAULT_RERANKER_MODEL_PRESET_ID,
    providerFamily: "openrouter",
    relevanceScoreFloor: null,
    upstreamModelId: "voyageai/rerank-2.5"
  },
  {
    automaticRoutePosition: 1,
    default: false,
    description: "First automatic fallback when the Voyage deployment is temporarily unavailable.",
    displayName: "Cohere Rerank 4 Pro",
    id: "cohere-rerank-4-pro",
    providerFamily: "openrouter",
    relevanceScoreFloor: null,
    upstreamModelId: "cohere/rerank-4-pro"
  },
  {
    automaticRoutePosition: 2,
    default: false,
    description: "Last automatic fallback; complete scores retain the calibrated near-zero junk floor.",
    displayName: "Qwen3 Reranker 8B",
    id: "qwen3-reranker-8b",
    providerFamily: "openrouter",
    relevanceScoreFloor: 0.01,
    upstreamModelId: "qwen/qwen3-reranker-8b"
  },
  {
    automaticRoutePosition: null,
    default: false,
    description: "Explicit production alternative when the 8B latency or cost envelope is unsuitable.",
    displayName: "Qwen3 Reranker 4B",
    id: "qwen3-reranker-4b",
    providerFamily: "openrouter",
    relevanceScoreFloor: null,
    upstreamModelId: "qwen/qwen3-reranker-4b"
  },
  {
    automaticRoutePosition: null,
    default: false,
    description: "Low-latency challenger for matched evaluation; never selected as an automatic fallback.",
    displayName: "Qwen3 Reranker 0.6B",
    id: "qwen3-reranker-0.6b",
    providerFamily: "openrouter",
    relevanceScoreFloor: null,
    upstreamModelId: "qwen/qwen3-reranker-0.6b"
  }
]);

export const automaticRerankerRoutePresets = Object.freeze(
  rerankerModelPresets
    .filter((preset) => preset.automaticRoutePosition !== null)
    .sort((left, right) =>
      Number(left.automaticRoutePosition) - Number(right.automaticRoutePosition))
);

function rerankerModelConfigurationBase(
  preset: Pick<RerankerModelPreset, "upstreamModelId">
) {
  return {
    adapterKind: "openrouter_rerank" as const,
    answerSelectable: false,
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    modelClass: "reranker" as const,
    openRouterRouting: { mode: "automatic" as const, providers: [] as [] },
    upstreamModelId: preset.upstreamModelId
  };
}

/** Persisted/runtime representation used by bootstrap and execution. */
export function rerankerModelConfiguration(
  preset: Pick<RerankerModelPreset, "upstreamModelId">
) {
  return {
    ...rerankerModelConfigurationBase(preset),
    responseTimeoutMs: RERANKER_RESPONSE_TIMEOUT_MS
  };
}

/** Browser/admin representation. Admin contracts use whole seconds. */
export function adminRerankerModelConfiguration(
  preset: Pick<RerankerModelPreset, "upstreamModelId">
) {
  return {
    ...rerankerModelConfigurationBase(preset),
    responseTimeoutSeconds: RERANKER_RESPONSE_TIMEOUT_MS / 1_000
  };
}

export function automaticRerankerPresetForUpstreamModel(
  upstreamModelId: string
): RerankerModelPreset | undefined {
  return automaticRerankerRoutePresets.find(
    (preset) => preset.upstreamModelId === upstreamModelId
  );
}

export function rerankerPresetsForFamily(
  family: string
): readonly RerankerModelPreset[] {
  return rerankerModelPresets.filter((preset) => preset.providerFamily === family);
}
