import { STRUCTURED_OUTPUT_LIMITS } from "../providers/structuredOutput";
import { structuredOutputPromptFits } from "../providers/structuredOutputLimits";
import { KNOWLEDGE_ANSWER_ACCEPTED_REQUEST_MAX_BYTES, knowledgeAnswerCanonicalJson, knowledgeAnswerHash } from "./answerGroundingV5";
import { decodeKnowledgeGroundingEffectiveExecutionPolicyV1, knowledgeGroundingReasoningEffortForRoleV1,
  type KnowledgeGroundingEffectiveExecutionPolicyV1 } from "./groundingExecutionPolicy";
import { KNOWLEDGE_EVIDENCE_ANSWER_DRAFT_SCHEMA_V1, KNOWLEDGE_EVIDENCE_ANSWER_REVIEW_SCHEMA_V1 } from "./evidenceAnswerV1";

export const KNOWLEDGE_EVIDENCE_ANSWER_PROTOCOL_V1 = "evidence_answer_review_v1" as const;
export const KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1 = Object.freeze({
  pipeline: KNOWLEDGE_EVIDENCE_ANSWER_PROTOCOL_V1, composeVersion: 1, reviewVersion: 1, settlementVersion: 1
} as const);
export type KnowledgeEvidenceAnswerOperationV1 = "knowledge_evidence_compose_v1" | "knowledge_evidence_review_v1";
export const KNOWLEDGE_EVIDENCE_ANSWER_MAX_OUTPUT_TOKENS_V1 = 8_192;
export type KnowledgeEvidenceAnswerSnapshotV1 = Readonly<{
  /** Omitted on accepted workflow 8 operations, whose prompts remain frozen. */
  workflowVersion?: 9 | 10;
  contractVersion: 1;
  draftPayloadHash: string | null;
  reviewPayloadHash: string | null;
  evidenceReceiptHash: string;
  executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1;
  maxOutputTokens: typeof KNOWLEDGE_EVIDENCE_ANSWER_MAX_OUTPUT_TOKENS_V1;
  name: KnowledgeEvidenceAnswerOperationV1;
  operation: KnowledgeEvidenceAnswerOperationV1;
  pipeline: typeof KNOWLEDGE_EVIDENCE_ANSWER_PROTOCOL_V1;
  reasoningEffort: string | null;
  schema: Readonly<Record<string, unknown>>;
  schemaHash: string;
  systemPrompt: string;
  tools: "none";
  transport: "native_strict" | "provider_neutral_json";
  userPrompt: string;
  version: 41;
}>;

export function isKnowledgeEvidenceAnswerOperationV1(value: unknown): value is KnowledgeEvidenceAnswerOperationV1 {
  return value === "knowledge_evidence_compose_v1" || value === "knowledge_evidence_review_v1";
}
export function createKnowledgeEvidenceAnswerSnapshotV1(input: Readonly<{
  workflowVersion?: 9 | 10;
  operation: KnowledgeEvidenceAnswerOperationV1;
  evidenceReceiptHash: string;
  executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1;
  draftPayloadHash?: string | null;
  reviewPayloadHash?: string | null;
  systemPrompt: string;
  userPrompt: string;
  transport: "native_strict" | "provider_neutral_json";
}>): KnowledgeEvidenceAnswerSnapshotV1 {
  const executionPolicy = decodeKnowledgeGroundingEffectiveExecutionPolicyV1(input.executionPolicy);
  const draftPayloadHash = input.draftPayloadHash ?? null;
  const reviewPayloadHash = input.reviewPayloadHash ?? null;
  const hashes = [input.evidenceReceiptHash, ...[draftPayloadHash, reviewPayloadHash].filter((hash): hash is string => hash !== null)];
  if (input.workflowVersion !== undefined && input.workflowVersion !== 9 && input.workflowVersion !== 10 ||
    !isKnowledgeEvidenceAnswerOperationV1(input.operation) || !executionPolicy || hashes.some(hash => !/^[0-9a-f]{64}$/u.test(hash)) ||
    input.operation === "knowledge_evidence_review_v1" && (draftPayloadHash === null || reviewPayloadHash !== null) ||
    input.operation === "knowledge_evidence_compose_v1" && (draftPayloadHash === null) !== (reviewPayloadHash === null) ||
    input.transport !== "native_strict" && input.transport !== "provider_neutral_json" ||
    typeof input.systemPrompt !== "string" || !input.systemPrompt.trim() || typeof input.userPrompt !== "string" || !input.userPrompt.trim() ||
    !structuredOutputPromptFits(input)) throw Error("knowledge_evidence_answer_snapshot_invalid");
  const compose = input.operation === "knowledge_evidence_compose_v1";
  const schema = compose ? KNOWLEDGE_EVIDENCE_ANSWER_DRAFT_SCHEMA_V1 : KNOWLEDGE_EVIDENCE_ANSWER_REVIEW_SCHEMA_V1;
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > STRUCTURED_OUTPUT_LIMITS.maxSchemaBytes) throw Error("knowledge_evidence_answer_schema_invalid");
  const snapshot = Object.freeze({
    ...(input.workflowVersion !== undefined ? { workflowVersion: input.workflowVersion } : {}),
    contractVersion: 1 as const, draftPayloadHash, reviewPayloadHash, evidenceReceiptHash: input.evidenceReceiptHash, executionPolicy,
    maxOutputTokens: KNOWLEDGE_EVIDENCE_ANSWER_MAX_OUTPUT_TOKENS_V1, name: input.operation, operation: input.operation,
    pipeline: KNOWLEDGE_EVIDENCE_ANSWER_PROTOCOL_V1,
    reasoningEffort: knowledgeGroundingReasoningEffortForRoleV1(executionPolicy, compose ? "draft" : "selector"),
    schema, schemaHash: knowledgeAnswerHash(schema), systemPrompt: input.systemPrompt, tools: "none" as const,
    transport: input.transport, userPrompt: input.userPrompt, version: 41 as const
  });
  if (Buffer.byteLength(knowledgeAnswerCanonicalJson(snapshot), "utf8") > KNOWLEDGE_ANSWER_ACCEPTED_REQUEST_MAX_BYTES) throw Error("knowledge_evidence_answer_snapshot_invalid");
  return snapshot;
}

export function decodeKnowledgeEvidenceAnswerSnapshotV1(value: unknown): KnowledgeEvidenceAnswerSnapshotV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("version" in value) || value.version !== 41) return null;
  try {
    const expected = createKnowledgeEvidenceAnswerSnapshotV1(value as Parameters<typeof createKnowledgeEvidenceAnswerSnapshotV1>[0]);
    return knowledgeAnswerCanonicalJson(expected) === knowledgeAnswerCanonicalJson(value) ? expected : null;
  } catch { return null; }
}
