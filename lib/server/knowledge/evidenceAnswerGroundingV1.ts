import { createHash } from "node:crypto";
import { knowledgeAnswerHash } from "./answerGroundingV5";
import { renderKnowledgeEvidenceAnswerPublicationV1 } from "./evidenceAnswerV1";
import type { KnowledgeEvidenceAnswerExecutionV1Result } from "./evidenceAnswerExecutionV1";
import { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1, isKnowledgeEvidenceAnswerOperationV1 } from "./evidenceAnswerSnapshotV1";
import { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2, isKnowledgeEvidenceAnswerOperationV2 } from "./evidenceAnswerSnapshotV2";
import type { KnowledgeEvidenceAnswerOperation } from "./evidenceAnswerSnapshot";
import { knowledgeEvidenceReceiptHash, type KnowledgeEvidencePackage } from "./evidencePackage";
import { decodeKnowledgeProviderAttemptUsage, type KnowledgeProviderAttemptUsage } from "./evidenceDispatchRepository";
import type { KnowledgeCoverageLimitationsV1 } from "./searchFailure";
import type { KnowledgeGroundingEffectiveExecutionPolicyV1 } from "./groundingExecutionPolicy";

export type KnowledgeEvidenceAnswerOperationReceiptV1 = Readonly<{
  operationId: string;
  ordinal: number;
  purpose: KnowledgeEvidenceAnswerOperation;
  acceptedRequestHash: string;
  acceptedResultHash: string;
  durationMs: number;
  providerRequestId: string | null;
  usage: KnowledgeProviderAttemptUsage;
}>;
export type KnowledgeGroundingEvidenceV57 = Readonly<{
  version: 57;
  contracts: typeof KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1;
  sessionId: string;
  receiptHash: string;
  evidenceReceiptHash: string;
  originalAnswerHash: string;
  finalAnswerHash: string;
  finalText: string;
  publicationPlanHash: string;
  requestCoverage: "complete" | "partial" | "none";
  outcome: "answered" | "insufficient_evidence";
  finalizationMode: "reviewed_blocks" | "insufficient";
  groundingStatus: "verified";
  draftBlockCount: number;
  supportedBlockCount: number;
  unsupportedBlockCount: number;
  contradictedBlockCount: number;
  missingRequirementCount: number;
  analysisComplete: boolean;
  compositionRepairAttempted: boolean;
  reviewRepairAttempted: boolean;
  refinementAttempted?: true;
  coverageLimitations: KnowledgeCoverageLimitationsV1;
  executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1;
  providerPinFingerprint: string;
  modelPinFingerprint: string;
  answerBindingFingerprint: string;
  operations: readonly KnowledgeEvidenceAnswerOperationReceiptV1[];
}>;
export type KnowledgeGroundingEvidenceV58 = Omit<KnowledgeGroundingEvidenceV57, "version" | "contracts"> & Readonly<{
  version: 58;
  contracts: typeof KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2;
}>;

export function groundSettledKnowledgeEvidenceAnswerV1(input: Readonly<{
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1;
  operations: readonly KnowledgeEvidenceAnswerOperationReceiptV1[];
  providerPinFingerprint: string;
  modelPinFingerprint: string;
  answerBindingFingerprint: string;
  result: KnowledgeEvidenceAnswerExecutionV1Result;
}>): KnowledgeGroundingEvidenceV57 | KnowledgeGroundingEvidenceV58 {
  const reviewV2 = input.result.contracts.pipeline === "evidence_answer_review_v2";
  if (![input.evidenceReceiptHash, input.providerPinFingerprint, input.modelPinFingerprint, input.answerBindingFingerprint].every(hash => /^[0-9a-f]{64}$/u.test(hash)) ||
    reviewV2 !== (input.result.review.version === 2) ||
    input.operations.length !== input.result.operations.length || input.operations.length < 2 || input.operations.length > (input.result.refinementAttempted ? 8 : 4) ||
    input.operations.some((operation, index) => !(reviewV2 ? isKnowledgeEvidenceAnswerOperationV2 : isKnowledgeEvidenceAnswerOperationV1)(operation.purpose) ||
      operation.ordinal !== index + 1 || operation.purpose !== input.result.operations[index]!.operation ||
      !/^[0-9a-f]{64}$/u.test(operation.acceptedRequestHash) || !/^[0-9a-f]{64}$/u.test(operation.acceptedResultHash) ||
      !Number.isSafeInteger(operation.durationMs) || operation.durationMs < 0 || !operation.operationId ||
      !decodeKnowledgeProviderAttemptUsage(operation.usage))) throw Error("knowledge_evidence_answer_receipt_invalid");
  const { publication, review, draft } = input.result;
  const finalText = renderKnowledgeEvidenceAnswerPublicationV1(publication, reviewV2 ? "Unanswered requirement:" : "Missing evidence:");
  const protocol = reviewV2 ? { version: 58 as const, contracts: KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2 }
    : { version: 57 as const, contracts: KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1 };
  return Object.freeze({
    ...protocol,
    sessionId: input.evidence.sessionId, receiptHash: knowledgeEvidenceReceiptHash(input.evidence),
    evidenceReceiptHash: input.evidenceReceiptHash, originalAnswerHash: input.operations[0]!.acceptedResultHash,
    finalAnswerHash: createHash("sha256").update(finalText, "utf8").digest("hex"), finalText,
    publicationPlanHash: knowledgeAnswerHash(publication), requestCoverage: publication.coverage,
    outcome: publication.blocks.length > 0 ? "answered" : "insufficient_evidence",
    finalizationMode: publication.blocks.length > 0 ? "reviewed_blocks" : "insufficient", groundingStatus: "verified",
    draftBlockCount: draft.blocks.length, supportedBlockCount: publication.blocks.length,
    unsupportedBlockCount: review.blocks.filter(block => block.verdict === "unsupported").length,
    contradictedBlockCount: review.blocks.filter(block => block.verdict === "contradicted").length,
    missingRequirementCount: publication.missingInformation.length, analysisComplete: publication.analysisComplete,
    compositionRepairAttempted: input.result.compositionRepairAttempted,
    reviewRepairAttempted: input.result.reviewRepairAttempted,
    ...(input.result.refinementAttempted ? { refinementAttempted: true as const } : {}),
    coverageLimitations: publication.coverageLimitations, executionPolicy: input.executionPolicy,
    providerPinFingerprint: input.providerPinFingerprint, modelPinFingerprint: input.modelPinFingerprint, answerBindingFingerprint: input.answerBindingFingerprint,
    operations: Object.freeze(input.operations.map(operation => Object.freeze({ ...operation, usage: Object.freeze({ ...operation.usage }) })))
  });
}
