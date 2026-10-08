export type RecoveryStateInvalidCode =
  | "knowledge_run_scope_invalid_in_storage"
  | "provider_dispatch_recovery_request_invalid_in_storage"
  | "tool_loop_call_invalid_in_storage"
  | "tool_loop_checkpoint_invalid_in_storage";

/**
 * A run's persisted recovery record was read and fails its own decoder.
 * Rereading returns the same bytes, so recovery ends the run instead of
 * retrying it. A failed read is never reported this way: it keeps the run for
 * a later attempt.
 */
export class RecoveryStateInvalidError extends Error {
  constructor(readonly code: RecoveryStateInvalidCode) {
    super(code);
    this.name = "RecoveryStateInvalidError";
  }
}
