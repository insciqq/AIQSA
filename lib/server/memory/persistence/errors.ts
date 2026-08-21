export const MEMORY_PERSISTENCE_ERROR_CODES = [
  "memory_active_generation_invalid",
  "memory_admission_deadline_exceeded",
  "memory_consent_conflict",
  "memory_consent_policy_changed",
  "memory_counter_contract_invalid",
  "memory_embedding_unavailable",
  "memory_fact_identity_conflict",
  "memory_fact_not_found",
  "memory_fact_suppressed",
  "memory_fact_version_stale",
  "memory_idempotency_conflict",
  "memory_input_invalid",
  "memory_mutation_authorization_invalid",
  "memory_owner_unavailable",
  "memory_plaintext_not_allowed",
  "memory_revision_conflict",
  "memory_scope_unavailable",
  "memory_settings_conflict",
  "memory_suppression_fingerprint_invalid",
  "memory_suppression_historical_key_missing",
  "memory_suppression_shape_invalid",
  "memory_undo_unavailable"
] as const;

export type MemoryPersistenceErrorCode =
  (typeof MEMORY_PERSISTENCE_ERROR_CODES)[number];

/**
 * Persistence failures intentionally carry only a stable, content-free code.
 * Route and worker owners decide how much context is safe to expose or log.
 */
export class MemoryPersistenceError extends Error {
  readonly code: MemoryPersistenceErrorCode;

  constructor(code: MemoryPersistenceErrorCode) {
    super(code);
    this.name = "MemoryPersistenceError";
    this.code = code;
  }
}

export function memoryPersistenceFailure(code: MemoryPersistenceErrorCode): never {
  throw new MemoryPersistenceError(code);
}
