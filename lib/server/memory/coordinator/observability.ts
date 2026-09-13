import { logEvent, type LifecycleFields, type LifecycleOutcome, type LifecycleStage } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";

export function memoryStage(stage: string): LifecycleStage {
  switch (stage) {
    case "source_snapshot": case "verification_snapshot": case "relation_snapshot": return "preflight";
    case "binding": case "batch_binding": case "consolidation_binding":
    case "verification_binding": case "semantic_adjudication_binding": return "prepare";
    case "provider_call": case "consolidation_provider_call": case "verification_provider_call":
    case "semantic_adjudication_provider_call": case "contextual_key_generation": case "digest_generation": return "dispatch";
    case "batch_provider_call": return "embed";
    case "safety_classification": case "local_safety_projection": return "validate";
    case "authorized_apply": case "batch_authorized_apply": case "consolidation_authorized_apply":
    case "verification_authorized_apply": case "relation_authorized_apply": case "local_apply":
    case "lexical_apply": case "durable_output": return "publish";
    case "catching_up": return "rebuild";
    case "related_fact_lookup": return "read";
    default: return "progress";
  }
}

export function memoryFailureOutcome(code: string, fallback: "failed" | "blocked" = "failed"): LifecycleOutcome {
  switch (code) {
    case "memory_job_lease_lost": case "memory_deletion_lease_lost": case "memory_lexical_projection_lease_lost": return "lost_lease";
    case "memory_classifier_cancelled": case "memory_rebuild_cancelled": case "memory_reclassification_cancelled":
    case "memory_run_utility_cancelled": case "memory_speculation_cancelled": case "memory_synthesis_cancelled":
    case "memory_query_resolution_speculation_cancelled": return "cancelled";
    case "memory_dependency_source_stale": case "memory_embedding_batch_binding_stale":
    case "memory_embedding_batch_generation_stale": case "memory_embedding_batch_result_stale":
    case "memory_embedding_batch_target_stale": case "memory_embedding_binding_stale": case "memory_embedding_target_stale":
    case "memory_entity_merge_stale": case "memory_fact_add_stale": case "memory_fact_binding_stale":
    case "memory_fact_candidate_stale": case "memory_fact_decision_binding_stale": case "memory_fact_expire_stale":
    case "memory_fact_relation_generation_stale": case "memory_fact_relation_snapshot_stale":
    case "memory_fact_source_normalization_stale": case "memory_fact_source_stale": case "memory_fact_transition_stale":
    case "memory_fact_verification_stale": case "memory_fact_version_stale": case "memory_history_plan_stale":
    case "memory_history_search_entry_stale": case "memory_reclassification_snapshot_stale": case "memory_source_stale":
    case "memory_synthesis_snapshot_stale": case "memory_synthesis_source_stale": case "memory_vector_generation_stale":
    case "memory_version_stale": return "stale";
    default: return fallback;
  }
}

type MemoryWork = Readonly<{ id: string; attemptCount: number }>;

export function memoryAttempt(work: MemoryWork, fields: Omit<LifecycleFields, "subsystem" | "job_id" | "attempt">): void {
  logEvent("job_attempt", { subsystem: "memory", job_id: work.id, attempt: work.attemptCount, ...fields });
}

/** A rejected write retains its original exception for the coordinator's policy. */
export async function memoryPersistence(
  work: MemoryWork,
  stage: LifecycleStage,
  write: () => Promise<boolean>,
  fields: Readonly<{ action?: LifecycleFields["action"]; work_stage?: LifecycleStage; code?: string; delay_ms?: number; retry_at?: string }> = {},
  quietSuccess = false
): Promise<boolean> {
  try {
    const accepted = await write();
    if (!quietSuccess || !accepted) logEvent("job_persistence", {
      subsystem: "memory", job_id: work.id, attempt: work.attemptCount, stage,
      ...fields, outcome: accepted ? "confirmed" : "not_applied",
      retry_at: accepted ? fields.retry_at : undefined,
      delay_ms: accepted ? fields.delay_ms : undefined
    });
    return accepted;
  } catch (error) {
    logEvent("job_persistence", {
      subsystem: "memory", job_id: work.id, attempt: work.attemptCount, stage,
      action: fields.action, work_stage: fields.work_stage, code: fields.code, outcome: "unconfirmed",
      prisma_code: databaseFailureCode(error)
    });
    throw error;
  }
}
