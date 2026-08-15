export const MEMORY_RETRIEVAL_PIPELINE_VERSION = "memory-retrieval-core-v4";
export const MEMORY_RETRIEVAL_FUSION_VERSION = "memory-retrieval-rrf-v2";
export const MEMORY_CONTEXT_PACKER_VERSION = "memory-context-packer-v2";

export const MEMORY_RETRIEVAL_RRF_K = 60;
export const MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES = 120;
export const MEMORY_RETRIEVAL_MAX_PARALLEL_LANES = 4;
export const MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES = 24;

// Candidate generation deliberately has no semantic similarity cutoff. The
// relevance model, not a model-agnostic cosine constant, decides which fused
// candidates enter the dynamic pack. -1 is the complete cosine range floor.
export const MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR = -1;

export const MEMORY_CORE_CONTEXT_TARGET_TOKENS = 512;
export const MEMORY_CONTEXT_TARGET_TOKENS = 2_000;
export const MEMORY_CONTEXT_HARD_CAP_TOKENS = 2_500;
export const MEMORY_CORE_MAX_FACTS = 12;
export const MEMORY_CONTEXT_MAX_ITEMS = 12;
export const MEMORY_CONTEXT_MAX_DYNAMIC_FACTS = 8;
export const MEMORY_CONTEXT_MAX_HISTORY_SNIPPETS = 4;
export const MEMORY_CONTEXT_MAX_SOURCE_CHATS = 4;

export const MEMORY_RETRIEVAL_LANE_LIMITS = Object.freeze({
  FACT_EXACT: 16,
  FACT_FTS_SIMPLE: 24,
  FACT_RECENT: 12,
  FACT_VECTOR: 24,
  HISTORY_RECALL_EXACT: 20,
  HISTORY_RECALL_FTS_SIMPLE: 32,
  HISTORY_RECALL_RECENT: 16,
  HISTORY_RECALL_VECTOR: 32
} as const);

export const MEMORY_RETRIEVAL_LANE_ORDER = Object.freeze([
  "FACT_EXACT",
  "HISTORY_RECALL_EXACT",
  "FACT_FTS_SIMPLE",
  "HISTORY_RECALL_FTS_SIMPLE",
  "FACT_VECTOR",
  "HISTORY_RECALL_VECTOR",
  "FACT_RECENT",
  "HISTORY_RECALL_RECENT"
] as const);

export type MemoryRetrievalLane = (typeof MEMORY_RETRIEVAL_LANE_ORDER)[number];
