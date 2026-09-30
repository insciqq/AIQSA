import type { MemoryExecutionVersions } from "../execution";
import { memorySha256 } from "../persistence/lexical";

export const MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS = Object.freeze([
  "memory-maintenance-policy-v1", "memory-maintenance-policy-v2"
] as const);
export const MEMORY_MAINTENANCE_POLICY_VERSION = "memory-maintenance-policy-v2";
export function isSupportedMemoryMaintenancePolicy(value: unknown): value is typeof MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS[number] {
  return MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS.some((version) => version === value);
}
export const MEMORY_MAINTENANCE_PIPELINE_VERSION = "memory-maintenance-v1";
export const MEMORY_MAINTENANCE_BATCH_SIZE = 16;
export const MEMORY_MAINTENANCE_MAX_OWNERS = 8;
export const MEMORY_MAINTENANCE_QUIET_MS = 30 * 60 * 1_000;
export const MEMORY_MAINTENANCE_VERSIONS: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION,
  policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION,
  promptVersion: "memory-maintenance-prompt-v2",
  schemaVersion: "memory-maintenance-schema-v2",
  retrievalConfigFingerprint: "memory-maintenance-exact-sources-v1"
});
export type MemoryUsefulness = "DURABLE" | "ONGOING" | "EPISODIC";
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

export function memoryMaintenancePlan(sources: readonly MemoryMaintenanceSource[]): MemoryMaintenancePlan {
  return Object.freeze({ sources, sourceSnapshotHash: memorySha256({
    policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION,
    sources: sources.map(({ ref, versionId, sourceSnapshotHash }) => ({ ref, versionId, sourceSnapshotHash }))
  }) });
}
