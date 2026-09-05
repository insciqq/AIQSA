import { STRUCTURED_OUTPUT_LIMITS } from "../providers/structuredOutput";
import { KNOWLEDGE_ANSWER_ACCEPTED_REQUEST_MAX_BYTES, knowledgeAnswerCanonicalJson, knowledgeAnswerHash } from "./answerGroundingV5";
import { KNOWLEDGE_EVIDENCE_ANSWER_REVIEW_SCHEMA_V2 } from "./evidenceAnswerReviewV2";
import { createKnowledgeEvidenceAnswerSnapshotV1, type KnowledgeEvidenceAnswerSnapshotV1 } from "./evidenceAnswerSnapshotV1";

export const KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2 = Object.freeze({
  pipeline: "evidence_answer_review_v2", composeVersion: 2, reviewVersion: 2, settlementVersion: 1
} as const);
export type KnowledgeEvidenceAnswerOperationV2 = "knowledge_evidence_compose_v2" | "knowledge_evidence_review_v2";
export type KnowledgeEvidenceAnswerSnapshotV2 = Omit<KnowledgeEvidenceAnswerSnapshotV1,
  "contractVersion" | "name" | "operation" | "pipeline" | "version" | "workflowVersion"> & Readonly<{
  contractVersion: 2;
  name: KnowledgeEvidenceAnswerOperationV2;
  operation: KnowledgeEvidenceAnswerOperationV2;
  pipeline: typeof KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2.pipeline;
  version: 42;
  workflowVersion: 11;
}>;

export function isKnowledgeEvidenceAnswerOperationV2(value: unknown): value is KnowledgeEvidenceAnswerOperationV2 {
  return value === "knowledge_evidence_compose_v2" || value === "knowledge_evidence_review_v2";
}

export function createKnowledgeEvidenceAnswerSnapshotV2(input: Omit<Parameters<typeof createKnowledgeEvidenceAnswerSnapshotV1>[0],
  "operation" | "workflowVersion"> & Readonly<{ operation: KnowledgeEvidenceAnswerOperationV2; workflowVersion: 11 }>): KnowledgeEvidenceAnswerSnapshotV2 {
  if (!isKnowledgeEvidenceAnswerOperationV2(input.operation) || input.workflowVersion !== 11) throw Error("knowledge_evidence_answer_snapshot_invalid");
  const compose = input.operation === "knowledge_evidence_compose_v2";
  // Share the unchanged transport, execution-policy, hash and prompt fences.
  // This intermediate value is never dispatched or persisted as a V1 request.
  const base = createKnowledgeEvidenceAnswerSnapshotV1({ ...input, workflowVersion: 10,
    operation: compose ? "knowledge_evidence_compose_v1" : "knowledge_evidence_review_v1" });
  const schema = compose ? base.schema : KNOWLEDGE_EVIDENCE_ANSWER_REVIEW_SCHEMA_V2;
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > STRUCTURED_OUTPUT_LIMITS.maxSchemaBytes) throw Error("knowledge_evidence_answer_schema_invalid");
  const snapshot = Object.freeze({ ...base, contractVersion: 2 as const, name: input.operation, operation: input.operation,
    pipeline: KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2.pipeline, version: 42 as const, workflowVersion: 11 as const,
    schema, schemaHash: knowledgeAnswerHash(schema) });
  if (Buffer.byteLength(knowledgeAnswerCanonicalJson(snapshot), "utf8") > KNOWLEDGE_ANSWER_ACCEPTED_REQUEST_MAX_BYTES) throw Error("knowledge_evidence_answer_snapshot_invalid");
  return snapshot;
}

export function decodeKnowledgeEvidenceAnswerSnapshotV2(value: unknown): KnowledgeEvidenceAnswerSnapshotV2 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("version" in value) || value.version !== 42) return null;
  try {
    const expected = createKnowledgeEvidenceAnswerSnapshotV2(value as Parameters<typeof createKnowledgeEvidenceAnswerSnapshotV2>[0]);
    return knowledgeAnswerCanonicalJson(expected) === knowledgeAnswerCanonicalJson(value) ? expected : null;
  } catch { return null; }
}
