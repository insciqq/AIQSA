export const MEMORY_READ_UTILITY_POLICIES = [
  "CONTROL_RESOLVER_V1",
  "DETERMINISTIC_READ_V1"
] as const;

export type MemoryReadUtilityPolicy =
  (typeof MEMORY_READ_UTILITY_POLICIES)[number];

export const DEFAULT_MEMORY_READ_UTILITY_POLICY: MemoryReadUtilityPolicy =
  "DETERMINISTIC_READ_V1";

/** Decode/test-only identifier for runs accepted before deterministic reads
 * became the product path. Production admission never selects this policy. */
export const LEGACY_MEMORY_READ_UTILITY_POLICY: MemoryReadUtilityPolicy =
  "CONTROL_RESOLVER_V1";
