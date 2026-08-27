import { memorySha256 } from "../persistence/lexical";

export type MemoryHistoryAdmissionBarrier = Readonly<{
  createdAt: Date;
  explicitOverrideAllowed: boolean;
  id: string;
  kind: string;
  memoryGeneration: number;
  sourceCreatedAtCutoff: Date;
}>;

export type MemoryHistoryAdmissionPauseInterval = Readonly<{
  id: string;
  memoryGeneration: number;
  pausedAt: Date;
  resumedAt: Date | null;
  scope: string;
}>;

export type MemoryHistoryAdmissionSuppression = Readonly<{
  expiresAt: Date | null;
  fingerprintKeyVersion: string;
  id: string;
  scope: string;
  sourceBranchGeneration: number | null;
  sourceChatId: string | null;
  sourceMessageId: string | null;
}>;

/**
 * Canonical fingerprint for controls that can change one chat's reusable
 * history projection. Incremental indexing and full-set rebuild must use this
 * exact shape or a healthy active generation can appear permanently stale.
 */
export function memoryHistorySuppressionIdentitySnapshot(input: Readonly<{
  barriers: readonly MemoryHistoryAdmissionBarrier[];
  checkpointResumeCutoff: Date | null;
  pauseIntervals: readonly MemoryHistoryAdmissionPauseInterval[];
  suppressions: readonly MemoryHistoryAdmissionSuppression[];
}>): string {
  return memorySha256({
    barriers: input.barriers.map((barrier) => ({
      createdAt: barrier.createdAt,
      explicitOverrideAllowed: barrier.explicitOverrideAllowed,
      id: barrier.id,
      kind: barrier.kind,
      memoryGeneration: barrier.memoryGeneration,
      sourceCreatedAtCutoff: barrier.sourceCreatedAtCutoff
    })),
    checkpointResumeCutoff: input.checkpointResumeCutoff,
    pauseIntervals: input.pauseIntervals,
    suppressions: input.suppressions.map((suppression) => ({
      expiresAt: suppression.expiresAt,
      fingerprintKeyVersion: suppression.fingerprintKeyVersion,
      id: suppression.id,
      scope: suppression.scope,
      sourceBranchGeneration: suppression.sourceBranchGeneration,
      sourceChatId: suppression.sourceChatId,
      sourceMessageId: suppression.sourceMessageId
    }))
  });
}
