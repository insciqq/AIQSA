// Dream synthesis is retired. Only the version vocabulary of its persisted
// rows remains: forgotten PATTERN versions keep `memory-synthesis-v2` as their
// pipeline version, and frozen evidence keeps the policy identities.

export const MEMORY_SYNTHESIS_PIPELINE_VERSION = "memory-synthesis-v2";
export const MEMORY_SYNTHESIS_POLICY_VERSION = "memory-synthesis-policy-v6";
export const MEMORY_SYNTHESIS_PROMPT_VERSION = "memory-synthesis-prompt-v9";
export const MEMORY_SYNTHESIS_SCHEMA_VERSION = "memory-synthesis-schema-v4";

/** Read only by a retired benchmark evidence field until it is removed. */
export const MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES = 2;
