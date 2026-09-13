import { logEvent, type LifecycleStage } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { observedFailureCode } from "../providers/providerObservability";
import { ChatPdfPreparationError } from "./chatPdfCore";

/** Observe the resolved guard/commit result, never the intent to write. */
export async function observeChatPdfPersistence<T>(runId: string, stage: LifecycleStage, operation: () => Promise<T>): Promise<T> {
  try {
    const result = await operation();
    logEvent("job_persistence", { subsystem: "pdf", run_id: runId, stage,
      outcome: result === false ? "not_applied" : "confirmed" });
    return result;
  } catch (error) {
    logEvent("job_persistence", { subsystem: "pdf", run_id: runId, stage,
      outcome: error instanceof ChatPdfPreparationError && error.code === "pdf_preparation_unavailable" ? "not_applied" : "unconfirmed",
      code: observedFailureCode(error), prisma_code: databaseFailureCode(error) });
    throw error;
  }
}
