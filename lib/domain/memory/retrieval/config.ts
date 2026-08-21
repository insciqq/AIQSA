export const MEMORY_RETRIEVAL_PIPELINE_VERSION = "memory-personal-v1";
export const MEMORY_RETRIEVAL_FUSION_VERSION = "memory-retrieval-rrf-v3";
export const MEMORY_CONTEXT_PACKER_VERSION = "memory-context-packer-v3";

export const MEMORY_RETRIEVAL_RRF_K = 60;
export const MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES = 30;
export const MEMORY_RETRIEVAL_MAX_PARALLEL_LANES = 4;
export const MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES = 30;

// Candidate generation deliberately has no semantic similarity cutoff. Only
// the bounded nearest eligible candidates reach the mandatory relevance model,
// which remains the authority for admission into the dynamic context pack.
export const MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR = -1;
export const MEMORY_RETRIEVAL_RERANK_SCORE_FLOOR = 0.6;

export const MEMORY_CORE_CONTEXT_TARGET_TOKENS = 128;
export const MEMORY_CONTEXT_TARGET_TOKENS = 1_400;
export const MEMORY_CONTEXT_HARD_CAP_TOKENS = 1_800;
export const MEMORY_CORE_MAX_FACTS = 4;
export const MEMORY_CONTEXT_MAX_ITEMS = 13;
export const MEMORY_CONTEXT_MAX_DYNAMIC_FACTS = 6;
export const MEMORY_CONTEXT_MAX_HISTORY_SNIPPETS = 3;
export const MEMORY_CONTEXT_MAX_SOURCE_CHATS = 3;
export const MEMORY_CONTEXT_DYNAMIC_FACT_TARGET_TOKENS = 500;
export const MEMORY_CONTEXT_HISTORY_TARGET_TOKENS = 750;

export const MEMORY_RETRIEVAL_LANE_LIMITS = Object.freeze({
  FACT_EXACT: 8,
  FACT_FTS_SIMPLE: 12,
  FACT_RECENT: 4,
  FACT_VECTOR: 12,
  HISTORY_RECALL_EXACT: 4,
  HISTORY_RECALL_FTS_SIMPLE: 6,
  HISTORY_RECALL_RECENT: 3,
  HISTORY_RECALL_VECTOR: 6
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
