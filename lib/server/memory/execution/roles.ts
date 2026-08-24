export const MEMORY_EXECUTION_ROLES = [
  "MEMORY_CONTROL",
  "MEMORY_STATEMENT_CLASSIFY",
  "MEMORY_HISTORY_CLASSIFY",
  "MEMORY_RECLASSIFY",
  "MEMORY_FACT_EXTRACT",
  "MEMORY_CONSOLIDATE",
  "MEMORY_SYNTHESIZE",
  "MEMORY_RERANK",
  "MEMORY_DOCUMENT_EMBED",
  "MEMORY_QUERY_EMBED"
] as const;

export type MemoryExecutionRole = (typeof MEMORY_EXECUTION_ROLES)[number];

/**
 * Retired role vocabulary kept only for decoding/terminalising pre-v1 rows.
 * It is deliberately not part of MEMORY_EXECUTION_ROLES, policy destinations,
 * or the admission validator, so no new execution can target verification.
 */
export type MemoryLegacyExecutionRole = "MEMORY_VERIFY";

export const MEMORY_EMBEDDING_ROLES = [
  "MEMORY_DOCUMENT_EMBED",
  "MEMORY_QUERY_EMBED"
] as const satisfies readonly MemoryExecutionRole[];

export const MEMORY_STRICT_OUTPUT_ROLES = [
  "MEMORY_CONTROL",
  "MEMORY_STATEMENT_CLASSIFY",
  "MEMORY_HISTORY_CLASSIFY",
  "MEMORY_RECLASSIFY",
  "MEMORY_FACT_EXTRACT",
  "MEMORY_CONSOLIDATE",
  "MEMORY_SYNTHESIZE",
  "MEMORY_RERANK"
] as const satisfies readonly MemoryExecutionRole[];

export function isMemoryExecutionRole(value: unknown): value is MemoryExecutionRole {
  return typeof value === "string" && MEMORY_EXECUTION_ROLES.some((role) => role === value);
}

export function isMemoryEmbeddingRole(
  role: MemoryExecutionRole
): role is (typeof MEMORY_EMBEDDING_ROLES)[number] {
  return MEMORY_EMBEDDING_ROLES.some((candidate) => candidate === role);
}

export function memoryRoleRequiresStrictOutput(role: MemoryExecutionRole): boolean {
  return MEMORY_STRICT_OUTPUT_ROLES.some((candidate) => candidate === role);
}
