import { logEvent } from "../observability";
import { databaseFailureCode as runDatabaseFailureCode } from "../observability/databaseFailure";
export { databaseFailureCode as runDatabaseFailureCode } from "../observability/databaseFailure";

export function logRunPersistence(runId: string,
  stage: "complete" | "fail" | "cancel" | "preparation",
  outcome: "confirmed" | "not_applied" | "unconfirmed", error?: unknown): void {
  logEvent("run_persistence", { run_id: runId, stage, outcome,
    prisma_code: outcome === "unconfirmed" ? runDatabaseFailureCode(error) : undefined });
}
