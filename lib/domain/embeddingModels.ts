export type EmbeddingProviderFamily = "openai" | "openai_compatible" | "openrouter";

export type EmbeddingModelPreset = Readonly<{
  contextWindow: number;
  default: boolean;
  description: string;
  displayName: string;
  id: "bge-m3" | "gemini-embedding-2" | "qwen3-embedding-8b" | "text-embedding-3-large";
  nativeDimension: number;
  providerFamily: EmbeddingProviderFamily;
  queryInstructionTemplate: string | null;
  supportsMrl: boolean;
  targetDimension: number;
  upstreamModelId: string;
}>;

export const DEFAULT_EMBEDDING_MODEL_PRESET_ID = "qwen3-embedding-8b" as const;

export const embeddingModelPresets: readonly EmbeddingModelPreset[] = Object.freeze([
  {
    contextWindow: 32_768,
    default: true,
    description: "Default multilingual retrieval preset; queries receive the retrieval instruction and documents remain bare.",
    displayName: "Qwen3 Embedding 8B",
    id: DEFAULT_EMBEDDING_MODEL_PRESET_ID,
    nativeDimension: 4_096,
    providerFamily: "openrouter",
    queryInstructionTemplate: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: {text}",
    supportsMrl: true,
    targetDimension: 1_536,
    upstreamModelId: "qwen/qwen3-embedding-8b"
  },
  {
    contextWindow: 8_192,
    default: false,
    description: "General-purpose Google embedding model exposed through the configured OpenRouter endpoint.",
    displayName: "Gemini Embedding 2",
    id: "gemini-embedding-2",
    nativeDimension: 3_072,
    providerFamily: "openrouter",
    queryInstructionTemplate: null,
    supportsMrl: true,
    targetDimension: 1_536,
    upstreamModelId: "google/gemini-embedding-2"
  },
  {
    contextWindow: 8_192,
    default: false,
    description: "Native 1024-dimensional multilingual vectors; truncation is intentionally unavailable.",
    displayName: "BGE-M3",
    id: "bge-m3",
    nativeDimension: 1_024,
    providerFamily: "openrouter",
    queryInstructionTemplate: null,
    supportsMrl: false,
    targetDimension: 1_024,
    upstreamModelId: "baai/bge-m3"
  },
  {
    contextWindow: 8_192,
    default: false,
    description: "OpenAI native embedding deployment shortened locally to the standard retrieval dimension.",
    displayName: "Text Embedding 3 Large",
    id: "text-embedding-3-large",
    nativeDimension: 3_072,
    providerFamily: "openai",
    queryInstructionTemplate: null,
    supportsMrl: true,
    targetDimension: 1_536,
    upstreamModelId: "text-embedding-3-large"
  }
]);

export function embeddingPresetsForFamily(
  family: string
): readonly EmbeddingModelPreset[] {
  return embeddingModelPresets.filter((preset) => preset.providerFamily === family);
}
