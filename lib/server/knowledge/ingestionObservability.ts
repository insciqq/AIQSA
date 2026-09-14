import { logEvent, type LifecycleFields, type LifecycleStage } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { KnowledgeIngestionError, KnowledgeWorkClaim } from "./ingestionTypes";

type FailureFields = Readonly<{ code: string; stage?: LifecycleStage; httpStatus?: number; prisma_code?: string }>;
const originalFailures = new WeakMap<KnowledgeIngestionError, FailureFields>();

/** Carries only fields already projected by the typed boundary, never an error payload. */
export function retainIngestionFailure(failure: KnowledgeIngestionError, fields: FailureFields): KnowledgeIngestionError {
  originalFailures.set(failure, fields);
  return failure;
}

export function ingestionFailureFields(error: unknown, fallback: KnowledgeIngestionError): FailureFields {
  return originalFailures.get(fallback) ?? { code: fallback.code, prisma_code: databaseFailureCode(error) };
}

export function ingestionStage(claim: KnowledgeWorkClaim): LifecycleStage {
  const stages: Record<KnowledgeWorkClaim["state"], LifecycleStage> = {
    queued: "prepare", parsing: "parse", chunking: "chunk", embedding: "embed"
  };
  return stages[claim.state];
}

export function ingestionAttempt(claim: KnowledgeWorkClaim, fields: Omit<LifecycleFields, "subsystem" | "job_id" | "attempt">): void {
  logEvent("job_attempt", { subsystem: "knowledge", job_id: claim.artifact.id, attempt: claim.attemptCount, ...fields });
}

export async function ingestionPersistence<T>(
  claim: KnowledgeWorkClaim,
  stage: LifecycleStage,
  write: () => Promise<T>,
  accepted: (result: T) => boolean,
  fields: Readonly<{ action?: LifecycleFields["action"]; code?: string; delay_ms?: number; retry_at?: string }> = {},
  quietSuccess = false
): Promise<T> {
  try {
    const result = await write();
    const confirmed = accepted(result);
    if (!quietSuccess || !confirmed) logEvent("job_persistence", {
      subsystem: "knowledge", job_id: claim.artifact.id, attempt: claim.attemptCount, stage,
      ...fields, outcome: confirmed ? "confirmed" : "not_applied",
      retry_at: confirmed ? fields.retry_at : undefined,
      delay_ms: confirmed ? fields.delay_ms : undefined
    });
    return result;
  } catch (error) {
    logEvent("job_persistence", {
      subsystem: "knowledge", job_id: claim.artifact.id, attempt: claim.attemptCount, stage,
      action: fields.action, code: fields.code, outcome: "unconfirmed",
      prisma_code: databaseFailureCode(error)
    });
    throw error;
  }
}
