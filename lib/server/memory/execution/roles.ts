export const MEMORY_EXECUTION_ROLES = [
  "MEMORY_CONTROL",
  "MEMORY_STATEMENT_CLASSIFY",
  "MEMORY_HISTORY_CLASSIFY",
  "MEMORY_RECLASSIFY",
  "MEMORY_FACT_EXTRACT",
  "MEMORY_CONSOLIDATE",
  "MEMORY_SYNTHESIZE",
  "MEMORY_RERANK",
  "MEMORY_QUERY_RESOLVE",
  "MEMORY_AGGREGATE",
  "MEMORY_DOCUMENT_EMBED",
  "MEMORY_QUERY_EMBED"
] as const;

export type MemoryExecutionRole = (typeof MEMORY_EXECUTION_ROLES)[number];

// Kept in the stored-role vocabulary so immutable v12 snapshots remain
// decodable. Retired roles never receive a current policy destination, so
// admission cannot create or resume their provider work.
export const MEMORY_RETIRED_EXECUTION_ROLES = [
  "MEMORY_AGGREGATE",
  "MEMORY_QUERY_RESOLVE"
] as const satisfies readonly MemoryExecutionRole[];

export const MEMORY_EXECUTABLE_ROLES = MEMORY_EXECUTION_ROLES.filter((role) =>
  !MEMORY_RETIRED_EXECUTION_ROLES.some((retired) => retired === role));

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
  "MEMORY_QUERY_RESOLVE"
] as const satisfies readonly MemoryExecutionRole[];

export const MEMORY_FORCED_TOOL_CALL_ROLES = [
  "MEMORY_CONTROL",
  "MEMORY_FACT_EXTRACT",
  "MEMORY_CONSOLIDATE",
  "MEMORY_QUERY_RESOLVE"
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

export function memoryRoleRequiresForcedToolCall(role: MemoryExecutionRole): boolean {
  return MEMORY_FORCED_TOOL_CALL_ROLES.some((candidate) => candidate === role);
}
