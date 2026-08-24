/** Provider- and runtime-neutral retrieval values shared by the strict
 * Memory control wire and the domain planner. Keep this module a dependency
 * leaf so browser-safe contracts never import server/domain implementations. */
export const MEMORY_RETRIEVAL_MODES = [
  "CURRENT_PROFILE",
  "TARGETED_CURRENT",
  "HISTORICAL_MEMORY",
  "PAST_CHAT_SEARCH",
  "HISTORY_OVERVIEW"
] as const;

export type MemoryRetrievalMode = (typeof MEMORY_RETRIEVAL_MODES)[number];

export const MEMORY_TEMPORAL_INTENTS = [
  "CURRENT",
  "HISTORICAL",
  "AS_OF",
  "BETWEEN",
  "ANY"
] as const;

export type MemoryTemporalIntent = (typeof MEMORY_TEMPORAL_INTENTS)[number];
