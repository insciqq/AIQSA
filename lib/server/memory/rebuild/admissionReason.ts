import { logEvent } from "../../observability";

/**
 * Why a full search-index rebuild was admitted. Each admission records one
 * content-free `service_operation` (stage `rebuild`, outcome `started`) whose
 * code is `memory_rebuild_reason_<reason>`, registered in
 * observability/failureCodes.json, so operator telemetry tells a cutover safety
 * net, a deployment's pipeline change or an embedding setup apart.
 */
export const MEMORY_REBUILD_ADMISSION_REASONS = [
  "admin",
  "embedding_model",
  "embedding_setup",
  "index_incomplete",
  "missing_generation",
  "pipeline_version",
  "resume",
  "revision_lag",
  "tool_text_repair"
] as const;

export type MemoryRebuildAdmissionReason =
  (typeof MEMORY_REBUILD_ADMISSION_REASONS)[number];

export function memoryRebuildAdmissionCode(
  reason: MemoryRebuildAdmissionReason
): `memory_rebuild_reason_${MemoryRebuildAdmissionReason}` {
  return `memory_rebuild_reason_${reason}`;
}

/** Call only after the admitting transaction committed. */
export function logMemoryRebuildAdmission(
  reason: MemoryRebuildAdmissionReason,
  jobId: string
): void {
  logEvent("service_operation", {
    code: memoryRebuildAdmissionCode(reason),
    job_id: jobId,
    outcome: "started",
    stage: "rebuild",
    subsystem: "memory"
  });
}
