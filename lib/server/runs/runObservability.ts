import { logEvent } from "../observability";
import {
  databaseFailureCode as runDatabaseFailureCode,
  databaseFailureKind as runDatabaseFailureKind
} from "../observability/databaseFailure";
export {
  databaseFailureCode as runDatabaseFailureCode,
  databaseFailureKind as runDatabaseFailureKind
} from "../observability/databaseFailure";

export function logRunPersistence(runId: string,
  stage: "complete" | "fail" | "cancel" | "preparation",
  outcome: "confirmed" | "not_applied" | "unconfirmed", error?: unknown): void {
  logEvent("run_persistence", { run_id: runId, stage, outcome,
    prisma_code: outcome === "unconfirmed" ? runDatabaseFailureCode(error) : undefined,
    db_failure: outcome === "unconfirmed" ? runDatabaseFailureKind(error) : undefined });
}
