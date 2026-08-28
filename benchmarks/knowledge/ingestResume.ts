export type KnowledgeBenchmarkSourceRecoveryState =
  | "needs_attention"
  | "processing"
  | "ready";

export type KnowledgeBenchmarkUploadRecoveryDisposition =
  | "fail"
  | "recover"
  | "retry"
  | "wait";

/**
 * Upload items retain their original artifact forever. A failed item without
 * a Source still owns the ordinary upload retry path. Once a Source exists,
 * only its current product readiness can prove recovery after Reprocess or a
 * profile migration; the historical item itself is no longer authoritative.
 */
export function knowledgeBenchmarkUploadRecoveryDisposition(input: Readonly<{
  sourceId: string | null;
  sourceState?: KnowledgeBenchmarkSourceRecoveryState;
}>): KnowledgeBenchmarkUploadRecoveryDisposition {
  if (!input.sourceId) return "retry";
  if (input.sourceState === "ready") return "recover";
  if (input.sourceState === "needs_attention") return "fail";
  return "wait";
}
