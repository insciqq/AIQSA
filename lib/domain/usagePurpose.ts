/**
 * What a usage record paid for, fixed when the record is written. Personal
 * purposes are the work of models a user chose (answers, the Search they
 * enabled, images they asked for) and count toward that user's budget. System
 * purposes are the work of administrator-assigned system models and count
 * only toward the installation's pooled cap. `other` marks only legacy records
 * whose purpose could not be recovered.
 */
export const PERSONAL_USAGE_PURPOSES = ["chat_answer", "web_search", "image_generation"] as const;
export type PersonalUsagePurpose = (typeof PERSONAL_USAGE_PURPOSES)[number];

export const SYSTEM_USAGE_PURPOSES = [
  "chat_title", "chat_summary", "chat_vision", "chat_pdf", "skill_selection",
  "memory_processing", "memory_indexing", "memory_retrieval",
  "knowledge_indexing", "knowledge_retrieval", "model_check", "other"
] as const;
export type SystemUsagePurpose = (typeof SYSTEM_USAGE_PURPOSES)[number];

export const USAGE_PURPOSES = [...PERSONAL_USAGE_PURPOSES, ...SYSTEM_USAGE_PURPOSES] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

export function isUsagePurpose(value: unknown): value is UsagePurpose {
  return (USAGE_PURPOSES as readonly unknown[]).includes(value);
}

export function isPersonalUsagePurpose(purpose: UsagePurpose): purpose is PersonalUsagePurpose {
  return (PERSONAL_USAGE_PURPOSES as readonly string[]).includes(purpose);
}

/**
 * Purposes of a run's own usage attributions: the answer model's work (answer
 * rounds, Agent generation), its Search, and its Knowledge query embeddings.
 * The run's accounting rewrites exactly these rows; every other purpose linked
 * to the run belongs to its own writer.
 */
export const RUN_USAGE_ATTRIBUTION_PURPOSES = ["chat_answer", "web_search", "knowledge_retrieval"] as const satisfies readonly UsagePurpose[];
export type RunUsageAttributionPurpose = (typeof RUN_USAGE_ATTRIBUTION_PURPOSES)[number];

export function isRunUsageAttributionPurpose(value: unknown): value is RunUsageAttributionPurpose {
  return (RUN_USAGE_ATTRIBUTION_PURPOSES as readonly unknown[]).includes(value);
}

const MEMORY_INDEXING_ROLES: ReadonlySet<string> = new Set(["MEMORY_DOCUMENT_EMBED"]);
const MEMORY_RETRIEVAL_ROLES: ReadonlySet<string> = new Set([
  "MEMORY_QUERY_EMBED", "MEMORY_RERANK", "MEMORY_HISTORY_RELEVANCE", "MEMORY_QUERY_RESOLVE"
]);

/**
 * The purpose of a Memory execution role: document embeddings index, the
 * read-side roles (query embedding, reranking, relevance, query resolution)
 * retrieve, and every other role processes Memory (extraction, consolidation,
 * classification, control, synthesis).
 */
export function memoryRoleUsagePurpose(role: string): "memory_indexing" | "memory_processing" | "memory_retrieval" {
  if (MEMORY_INDEXING_ROLES.has(role)) return "memory_indexing";
  return MEMORY_RETRIEVAL_ROLES.has(role) ? "memory_retrieval" : "memory_processing";
}
