import { observedFailure } from "../providers/providerObservability";
import { databaseFailureCode, rememberDatabaseFailure } from "../observability/databaseFailure";

const failures = {
  publication: { code: "run_result_publication_failed", message: "The application could not publish the provider response. Do not repeat an operation whose outcome is uncertain." },
  accounting: { code: "run_usage_persistence_failed", message: "The provider returned a response, but the application could not confirm its usage record. This is an internal settlement failure; do not repeat an uncertain operation." },
  completion: { code: "run_completion_persistence_failed", message: "The application could not durably complete the response. This does not establish a provider failure or authorize repeating earlier operations." }
} as const;

/** Construct only at the local boundary that failed, never from upstream prose. */
export class RunSettlementError extends Error {
  readonly code: typeof failures[keyof typeof failures]["code"];
  constructor(readonly stage: keyof typeof failures, cause: unknown) {
    super(failures[stage].message, { cause });
    this.name = "RunSettlementError";
    this.code = failures[stage].code;
    rememberDatabaseFailure(this, databaseFailureCode(cause));
  }
}

export function runSettlementFailure(error: unknown): { code: RunSettlementError["code"]; message: string } | null {
  return error instanceof RunSettlementError ? { code: error.code, message: failures[error.stage].message } : null;
}

/** Preserve already typed authority/cancellation causes at a local callback. */
export function localSettlementError(stage: RunSettlementError["stage"], cause: unknown): unknown {
  const failure = observedFailure(cause);
  return cause instanceof RunSettlementError || failure.reason === "cancelled" ||
    failure.code !== "unknown" && failure.reason !== "deadline" && failure.reason !== "network"
    ? cause : new RunSettlementError(stage, cause);
}

export function isRunPersistenceFailureCode(code: string): boolean {
  return Object.values(failures).some(failure => failure.code === code) ||
    code === "memory_egress_receipt_conflict" || code === "tool_loop_usage_checkpoint_conflict";
}
