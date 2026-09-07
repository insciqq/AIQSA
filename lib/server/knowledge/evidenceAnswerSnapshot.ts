import { decodeKnowledgeEvidenceAnswerSnapshotV1, isKnowledgeEvidenceAnswerOperationV1, type KnowledgeEvidenceAnswerOperationV1, type KnowledgeEvidenceAnswerSnapshotV1 } from "./evidenceAnswerSnapshotV1";
import { decodeKnowledgeEvidenceAnswerSnapshotV2, isKnowledgeEvidenceAnswerOperationV2, type KnowledgeEvidenceAnswerOperationV2, type KnowledgeEvidenceAnswerSnapshotV2 } from "./evidenceAnswerSnapshotV2";

export type KnowledgeEvidenceAnswerOperation = KnowledgeEvidenceAnswerOperationV1 | KnowledgeEvidenceAnswerOperationV2;
export type KnowledgeEvidenceAnswerSnapshot = KnowledgeEvidenceAnswerSnapshotV1 | KnowledgeEvidenceAnswerSnapshotV2;
export function isKnowledgeEvidenceComposeOperation(value: KnowledgeEvidenceAnswerOperation): boolean {
  return value === "knowledge_evidence_compose_v1" || value === "knowledge_evidence_compose_v2";
}
export function isKnowledgeEvidenceAnswerOperation(value: unknown): value is KnowledgeEvidenceAnswerOperation {
  return isKnowledgeEvidenceAnswerOperationV1(value) || isKnowledgeEvidenceAnswerOperationV2(value);
}
export function decodeKnowledgeEvidenceAnswerSnapshot(value: unknown) {
  return decodeKnowledgeEvidenceAnswerSnapshotV1(value) ?? decodeKnowledgeEvidenceAnswerSnapshotV2(value);
}
