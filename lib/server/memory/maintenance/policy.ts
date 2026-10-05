import type { MemoryExecutionVersions } from "../execution";
import { memorySha256 } from "../persistence/lexical";

export const MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS = Object.freeze([
  "memory-maintenance-policy-v1", "memory-maintenance-policy-v2", "memory-maintenance-policy-v3", "memory-maintenance-policy-v4",
  "memory-maintenance-policy-v5"
] as const);
/** v5 reviews every unprotected automatic fact once more under the task-local
 * rules of prompt v6 and then again on its re-review cadence; earlier rows
 * stay as history and never cover a v5 review. An owner's first v5 pass also
 * retires the facts an earlier release left under a retracted subject root. */
export const MEMORY_MAINTENANCE_POLICY_VERSION = "memory-maintenance-policy-v5";
export function isSupportedMemoryMaintenancePolicy(value: unknown): value is typeof MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS[number] {
  return MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS.some((version) => version === value);
}
export const MEMORY_MAINTENANCE_PIPELINE_VERSION = "memory-maintenance-v1";
export const MEMORY_MAINTENANCE_BATCH_SIZE = 16;
export const MEMORY_MAINTENANCE_MAX_OWNERS = 8;
export const MEMORY_MAINTENANCE_QUIET_MS = 30 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** A blocker can clear without any lineage change; it is checked again weekly. */
export const MEMORY_MAINTENANCE_BLOCKED_RECHECK_MS = 7 * DAY_MS;
/** A settled decision that keeps a fact covers it only until its re-review:
 * a DURABLE keep the longest; any other keep, and a removal the verifier
 * rejected, the ongoing cadence; a keep that resolved contradictory labels
 * (reason unresolved_scope) a day, at most FALLBACK_RETRIES times in a row,
 * and the ongoing cadence after that. */
export const MEMORY_MAINTENANCE_REREVIEW_MS = Object.freeze({ durable: 120 * DAY_MS, ongoing: 30 * DAY_MS, fallback: DAY_MS });
export const MEMORY_MAINTENANCE_FALLBACK_RETRIES = 3;
/** Failed reviews of one review cycle of a version's current evidence (after
 * its latest settled decision, within the ongoing cadence) that cover it;
 * ordinary failures and invalid answers count separately. */
export const MEMORY_MAINTENANCE_MAX_FAILED_ATTEMPTS = 2;
export const MEMORY_MAINTENANCE_MAX_INVALID_OUTPUT_ATTEMPTS = 3;
/** A transient provider failure spends no budget; the version waits instead,
 * from the first delay, doubling per such failure up to the maximum. */
export const MEMORY_MAINTENANCE_TRANSIENT_RETRY_MS = Object.freeze({ first: 30 * 60 * 1_000, max: 24 * 60 * 60 * 1_000 });
/** Job outcomes the budgets read. A changed source found before dispatch
 * paid for nothing; `memory_job_failed` predates stable causes. */
export const MEMORY_MAINTENANCE_FAILURE_CODES = Object.freeze({
  dispatchStale: "memory_maintenance_dispatch_stale",
  invalidOutput: "memory_classifier_output_invalid",
  legacy: "memory_job_failed",
  transient: "memory_classifier_provider_unavailable"
} as const);
/** A job reviews once and verifies the proposed removals at most once. */
export type MemoryMaintenanceCall = "review" | "verify";
/** Attempts of one call, including in-call validation retries. */
export const MEMORY_MAINTENANCE_CALL_ATTEMPTS = 3;
/** Every attempt has its own binding and receipt ordinal: reviews 0, 2, 4 and
 * verifications 1, 3, 5. `attempt` 0 is the first call. */
export function memoryMaintenanceOrdinal(call: MemoryMaintenanceCall, attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= MEMORY_MAINTENANCE_CALL_ATTEMPTS) {
    throw new RangeError("memory_maintenance_ordinal_invalid");
  }
  return attempt * 2 + (call === "verify" ? 1 : 0);
}
export function memoryMaintenanceOrdinals(call: MemoryMaintenanceCall): readonly number[] {
  return Array.from({ length: MEMORY_MAINTENANCE_CALL_ATTEMPTS }, (_, attempt) => memoryMaintenanceOrdinal(call, attempt));
}
/** Background planning bounds: inside the existing background 20-30 s budgets. */
export const MEMORY_MAINTENANCE_SCHEDULE_TRANSACTION_BOUNDS = Object.freeze({
  maxWaitMs: 5_000,
  timeoutMs: 20_000
});
/** Each version keys the calls' input hashes and so their staged receipts;
 * review coverage follows the policy version alone. A decoder change that
 * leaves the request unchanged bumps only the schema version. */
export const MEMORY_MAINTENANCE_VERSIONS: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION,
  policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION,
  promptVersion: "memory-maintenance-prompt-v6",
  schemaVersion: "memory-maintenance-schema-v7",
  retrievalConfigFingerprint: "memory-maintenance-exact-sources-related-v3"
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
/** Another current memory of the owner, most similar to a reviewed source and
 * shown only to judge whether it contradicts or supersedes that source. It is
 * never reviewed or removed here. `ref` is the source ref, `M` and its rank. */
export type MemoryMaintenanceRelatedMemory = Readonly<{
  ref: string;
  factId: string;
  versionId: string;
  statement: string;
  observedAt: Date | null;
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
  /** Outside the source hash: attached for a call and revalidated before
   * every disclosure. */
  related?: readonly MemoryMaintenanceRelatedMemory[];
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
