export type RerankerModelPreset = Readonly<{
  default: boolean;
  description: string;
  displayName: string;
  id: "qwen3-reranker-0.6b" | "qwen3-reranker-4b" | "qwen3-reranker-8b";
  providerFamily: "openrouter";
  upstreamModelId: string;
}>;

export const DEFAULT_RERANKER_MODEL_PRESET_ID = "qwen3-reranker-8b" as const;

export const rerankerModelPresets: readonly RerankerModelPreset[] = Object.freeze([
  {
    default: true,
    description: "Accuracy-first multilingual qualification profile for Memory evidence ordering.",
    displayName: "Qwen3 Reranker 8B",
    id: DEFAULT_RERANKER_MODEL_PRESET_ID,
    providerFamily: "openrouter",
    upstreamModelId: "qwen/qwen3-reranker-8b"
  },
  {
    default: false,
    description: "Explicit production alternative when the 8B latency or cost envelope is unsuitable.",
    displayName: "Qwen3 Reranker 4B",
    id: "qwen3-reranker-4b",
    providerFamily: "openrouter",
    upstreamModelId: "qwen/qwen3-reranker-4b"
  },
  {
    default: false,
    description: "Low-latency challenger for matched evaluation; never selected as an automatic fallback.",
    displayName: "Qwen3 Reranker 0.6B",
    id: "qwen3-reranker-0.6b",
    providerFamily: "openrouter",
    upstreamModelId: "qwen/qwen3-reranker-0.6b"
  }
]);

export function rerankerPresetsForFamily(
  family: string
): readonly RerankerModelPreset[] {
  return rerankerModelPresets.filter((preset) => preset.providerFamily === family);
}
