import type { MemoryExecutionVersions } from "../execution";
import { memorySha256 } from "../persistence/lexical";

export const MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS = Object.freeze([
  "memory-maintenance-policy-v1", "memory-maintenance-policy-v2", "memory-maintenance-policy-v3"
] as const);
export const MEMORY_MAINTENANCE_POLICY_VERSION = "memory-maintenance-policy-v3";
export function isSupportedMemoryMaintenancePolicy(value: unknown): value is typeof MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS[number] {
  return MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS.some((version) => version === value);
}
export const MEMORY_MAINTENANCE_PIPELINE_VERSION = "memory-maintenance-v1";
export const MEMORY_MAINTENANCE_BATCH_SIZE = 16;
export const MEMORY_MAINTENANCE_MAX_OWNERS = 8;
export const MEMORY_MAINTENANCE_QUIET_MS = 30 * 60 * 1_000;
/** A blocker can clear without any lineage change; it is checked again weekly. */
export const MEMORY_MAINTENANCE_BLOCKED_RECHECK_MS = 7 * 24 * 60 * 60 * 1_000;
/** Background planning bounds: inside the existing background 20-30 s budgets. */
export const MEMORY_MAINTENANCE_SCHEDULE_TRANSACTION_BOUNDS = Object.freeze({
  maxWaitMs: 5_000,
  timeoutMs: 20_000
});
export const MEMORY_MAINTENANCE_VERSIONS: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION,
  policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION,
  promptVersion: "memory-maintenance-prompt-v3",
  schemaVersion: "memory-maintenance-schema-v3",
  retrievalConfigFingerprint: "memory-maintenance-exact-sources-v2"
});
export type MemoryUsefulness = "DURABLE" | "ONGOING" | "EPISODIC";
/** Fixed, content-free reasons of a non-final outcome. Only the planner (or
 * the apply of a reviewed source) records them; they are never logged. */
export const MEMORY_MAINTENANCE_BLOCKED_REASONS = Object.freeze([
  "pending_relation", "evidence_without_offsets", "source_changed"
] as const);
export const MEMORY_MAINTENANCE_UNREVIEWABLE_REASONS = Object.freeze([
  "unreviewable_context", "statement_too_long", "evidence_not_current"
] as const);
export type MemoryMaintenanceBlockedReason = (typeof MEMORY_MAINTENANCE_BLOCKED_REASONS)[number];
export type MemoryMaintenanceUnreviewableReason = (typeof MEMORY_MAINTENANCE_UNREVIEWABLE_REASONS)[number];
export type MemoryMaintenanceReasonCode = MemoryMaintenanceBlockedReason | MemoryMaintenanceUnreviewableReason;
export function memoryMaintenanceReasonDisposition(code: MemoryMaintenanceReasonCode): "BLOCKED" | "UNREVIEWABLE" {
  return MEMORY_MAINTENANCE_BLOCKED_REASONS.some((reason) => reason === code) ? "BLOCKED" : "UNREVIEWABLE";
}
export type MemoryMaintenanceEvidence = Readonly<{
  id: string;
  chatId: string;
  messageId: string;
  branchGeneration: number;
  sourceTextHash: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  observedAt: Date;
  createdAt: Date;
}>;
export type MemoryMaintenanceSource = Readonly<{
  ref: string;
  factId: string;
  versionId: string;
  statement: string;
  category: string;
  modality: string;
  confidence: number;
  usefulness: MemoryUsefulness | null;
  observedAt: Date;
  evidence: readonly MemoryMaintenanceEvidence[];
  context?: readonly Readonly<{ kind: "SOURCE_MESSAGE" | "REFERENCE_MESSAGE" | "FACT_DEPENDENCY";
    role: string; text: string; identityHash: string; observedAt?: string }>[];
  evidenceThrough: Date;
  sourceSnapshotHash: string;
}>;
export type MemoryMaintenancePlan = Readonly<{
  sources: readonly MemoryMaintenanceSource[];
  sourceSnapshotHash: string;
}>;
/** What a job reviews: the ordered refs, versions and hashes of its PENDING
 * reviews. It is derivable without source content. */
export type MemoryMaintenanceSourceIdentity = Readonly<{ ref: string; versionId: string; sourceSnapshotHash: string }>;

export function memoryMaintenancePlanHash(sources: readonly MemoryMaintenanceSourceIdentity[]): string {
  return memorySha256({
    policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION,
    sources: sources.map(({ ref, versionId, sourceSnapshotHash }) => ({ ref, versionId, sourceSnapshotHash }))
  });
}
export function memoryMaintenancePlan(sources: readonly MemoryMaintenanceSource[]): MemoryMaintenancePlan {
  return Object.freeze({ sources, sourceSnapshotHash: memoryMaintenancePlanHash(sources) });
}
