import { logEvent } from "../observability";
import {
  databaseFailureCode as runDatabaseFailureCode,
  databaseFailureKind as runDatabaseFailureKind
} from "../observability/databaseFailure";
import {
  observeTransactionTimings,
  transactionTimingFields,
  transactionTimingOf,
  type DbTransactionTiming
} from "../observability/transactionTiming";
export {
  databaseFailureCode as runDatabaseFailureCode,
  databaseFailureKind as runDatabaseFailureKind
} from "../observability/databaseFailure";

/**
 * One terminal write's record. `timing` is the write's own transaction
 * (`settleRunWrite`); a failed write's comes from its error.
 */
export function logRunPersistence(runId: string,
  stage: "complete" | "fail" | "cancel" | "preparation",
  outcome: "confirmed" | "not_applied" | "unconfirmed", error?: unknown, timing?: DbTransactionTiming): void {
  logEvent("run_persistence", { run_id: runId, stage, outcome,
    prisma_code: outcome === "unconfirmed" ? runDatabaseFailureCode(error) : undefined,
    db_failure: outcome === "unconfirmed" ? runDatabaseFailureKind(error) : undefined,
    ...transactionTimingFields(timing ?? (outcome === "unconfirmed" ? transactionTimingOf(error) : undefined)) });
}

/** Runs a terminal write and returns its result with the timing of the last transaction it settled. */
export async function settleRunWrite<T>(write: () => Promise<T>): Promise<Readonly<{ value: T; timing: DbTransactionTiming | undefined }>> {
  let timing: DbTransactionTiming | undefined;
  const value = await observeTransactionTimings(write, (settled) => { timing = settled; });
  return { value, timing };
}
