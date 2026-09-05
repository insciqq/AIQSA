import { createHash } from "node:crypto";

/** A Base binding or equal content is not an occurrence. The immutable
 * Source/Version/artifact/passage tuple also distinguishes repeated rows. */
export type KnowledgeEvidenceOccurrenceV1 = Readonly<{
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  sourceArtifactId: string | null;
}>;

export function knowledgeEvidenceOccurrenceKeyV1(value: KnowledgeEvidenceOccurrenceV1): string {
  const tuple = [value.documentId, value.documentVersionId, value.sourceArtifactId, value.chunkId];
  if (tuple.some((part, index) => !(index === 2 && part === null) &&
    (typeof part !== "string" || !part || part.length > 512 || part.includes("\u0000")))) {
    throw new Error("knowledge_evidence_occurrence_invalid");
  }
  return `occurrence_v1:${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`;
}

export function isKnowledgeEvidenceOccurrenceKeyV1(value: unknown): value is string {
  return typeof value === "string" && /^occurrence_v1:[0-9a-f]{64}$/u.test(value);
}

/** Historic receipts with no complete provenance cannot exclude a current
 * Source. Valid persisted tuples keep their exact identity across restart. */
export function decodeKnowledgeEvidenceOccurrenceKeyV1(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if ([entry.chunkId, entry.documentId, entry.documentVersionId].some((part) =>
    typeof part !== "string") || entry.sourceArtifactId !== null &&
      typeof entry.sourceArtifactId !== "string") return null;
  try {
    return knowledgeEvidenceOccurrenceKeyV1(entry as KnowledgeEvidenceOccurrenceV1);
  } catch {
    return null;
  }
}
