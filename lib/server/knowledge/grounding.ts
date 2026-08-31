import { createHash } from "node:crypto";
import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import {
  knowledgeEvidenceReceiptHash,
  type KnowledgeEvidencePackage
} from "./evidencePackage";
import {
  knowledgeAnswerContractPairForVersions,
  type KnowledgeAnswerContractVersions,
  type KnowledgeAnswerFallbackReason,
  type KnowledgeAnswerSettlementV5
} from "./answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
  type KnowledgeAnswerOperationV21,
  type KnowledgeAnswerV21ContractVersions
} from "./answerGroundingV21";
import { KNOWLEDGE_COVERAGE_AUDITOR_OPERATION } from "./coverageAuditV1";
import type { KnowledgeProviderAttemptUsage } from "./evidenceDispatchRepository";

export const KNOWLEDGE_GROUNDING_VERSION = 5 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V7 = 7 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V8 = 8 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V9 = 9 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V10 = 10 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V11 = 11 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V12 = 12 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V13 = 13 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V14 = 14 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V15 = 15 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION = 16 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V17 = 17 as const;

export type LegacyKnowledgeGroundingResult = Readonly<{
  finalAnswerHash: string;
  finalText: string;
  originalAnswerHash: string;
  outcome: "answered" | "insufficient_evidence";
  receiptHash: string;
  sessionId: string;
  version: typeof KNOWLEDGE_GROUNDING_VERSION;
}>;

export type KnowledgeGroundingEvidenceV7 = Readonly<{
  contradictedClaimCount: number;
  draftClaimCount: number;
  draftContractVersion: KnowledgeAnswerContractVersions["draftContractVersion"];
  draftHash: string;
  draftOperationId: string;
  durations: Readonly<{
    draftMs: number;
    selectorMs: number;
  }>;
  evidenceReceiptHash: string;
  fallbackReason: KnowledgeAnswerFallbackReason | null;
  finalAnswerHash: string;
  finalText: string;
  finalizationMode: KnowledgeAnswerSettlementV5["finalizationMode"];
  groundingStatus: KnowledgeAnswerSettlementV5["groundingStatus"];
  originalAnswerHash: string;
  outcome: KnowledgeAnswerSettlementV5["outcome"];
  providerRequestIds: Readonly<{
    draft: string | null;
    selector: string | null;
  }>;
  receiptHash: string;
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  selectorContractVersion: KnowledgeAnswerContractVersions["selectorContractVersion"];
  selectorHash: string;
  selectorOperationId: string;
  sessionId: string;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  usage: Readonly<{
    draft: KnowledgeProviderAttemptUsage;
    selector: KnowledgeProviderAttemptUsage;
  }>;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V7;
}>;

export type KnowledgeGroundingOperationEvidenceV8 = Readonly<{
  claimCount: number | null;
  durationMs: number;
  hash: string;
  operationId: string;
  providerRequestId: string | null;
  role: "final" | "initial" | "planner" | "primary" | "repair" | "supplement";
  usage: KnowledgeProviderAttemptUsage;
}>;

export type KnowledgeGroundingEvidenceV8 = Readonly<{
  adaptiveCorrectionApplied: boolean;
  contradictedClaimCount: number;
  correctionCompleted: boolean;
  draftClaimCount: number;
  draftContractVersion: 12;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidenceReceiptHash: string;
  fallbackReason: KnowledgeAnswerFallbackReason | null;
  finalAnswerHash: string;
  finalText: string;
  finalizationMode: KnowledgeAnswerSettlementV5["finalizationMode"];
  groundingStatus: KnowledgeAnswerSettlementV5["groundingStatus"];
  originalAnswerHash: string;
  outcome: KnowledgeAnswerSettlementV5["outcome"];
  receiptHash: string;
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  selectorContractVersion: 8;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  sessionId: string;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V8;
}>;

export type KnowledgeGroundingEvidenceV9 = Readonly<{
  adaptiveCorrectionApplied: boolean;
  contradictedClaimCount: number;
  correctionCompleted: boolean;
  draftClaimCount: number;
  draftContractVersion: 13;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidenceReceiptHash: string;
  fallbackReason: KnowledgeAnswerFallbackReason | null;
  finalAnswerHash: string;
  finalText: string;
  finalizationMode: KnowledgeAnswerSettlementV5["finalizationMode"];
  groundingStatus: KnowledgeAnswerSettlementV5["groundingStatus"];
  originalAnswerHash: string;
  outcome: KnowledgeAnswerSettlementV5["outcome"];
  receiptHash: string;
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  selectorContractVersion: 9;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  sessionId: string;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V9;
}>;

export type KnowledgeGroundingEvidenceV10 = Readonly<{
  adaptiveCorrectionApplied: boolean;
  contradictedClaimCount: number;
  correctionCompleted: boolean;
  draftClaimCount: number;
  draftContractVersion: 14;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidenceReceiptHash: string;
  fallbackReason: KnowledgeAnswerFallbackReason | null;
  finalAnswerHash: string;
  finalText: string;
  finalizationMode: KnowledgeAnswerSettlementV5["finalizationMode"];
  groundingStatus: KnowledgeAnswerSettlementV5["groundingStatus"];
  originalAnswerHash: string;
  outcome: KnowledgeAnswerSettlementV5["outcome"];
  receiptHash: string;
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  selectorContractVersion: 10;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  sessionId: string;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V10;
}>;

export type KnowledgeGroundingEvidenceV11 = Readonly<{
  adaptiveCorrectionApplied: boolean;
  contradictedClaimCount: number;
  correctionCompleted: boolean;
  draftClaimCount: number;
  draftContractVersion: 15;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidenceReceiptHash: string;
  fallbackReason: KnowledgeAnswerFallbackReason | null;
  finalAnswerHash: string;
  finalText: string;
  finalizationMode: KnowledgeAnswerSettlementV5["finalizationMode"];
  groundingStatus: KnowledgeAnswerSettlementV5["groundingStatus"];
  originalAnswerHash: string;
  outcome: KnowledgeAnswerSettlementV5["outcome"];
  receiptHash: string;
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  selectorContractVersion: 11;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  selectorValidationRepairApplied: boolean;
  selectorValidationRepairCompleted: boolean;
  sessionId: string;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V11;
}>;

export type KnowledgeGroundingEvidenceV12 = Readonly<{
  adaptiveCorrectionApplied: boolean;
  contradictedClaimCount: number;
  correctionCompleted: boolean;
  draftClaimCount: number;
  draftContractVersion: 16;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidenceReceiptHash: string;
  fallbackReason: KnowledgeAnswerFallbackReason | null;
  finalAnswerHash: string;
  finalText: string;
  finalizationMode: KnowledgeAnswerSettlementV5["finalizationMode"];
  groundingStatus: KnowledgeAnswerSettlementV5["groundingStatus"];
  originalAnswerHash: string;
  outcome: KnowledgeAnswerSettlementV5["outcome"];
  receiptHash: string;
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  selectorContractVersion: 12;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  selectorValidationRepairApplied: boolean;
  selectorValidationRepairCompleted: boolean;
  sessionId: string;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V12;
}>;

export type KnowledgeGroundingEvidenceV13 = Readonly<{
  adaptiveCorrectionApplied: boolean;
  contradictedClaimCount: number;
  correctionCompleted: boolean;
  draftClaimCount: number;
  draftContractVersion: 17;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidenceReceiptHash: string;
  fallbackReason: KnowledgeAnswerFallbackReason | null;
  finalAnswerHash: string;
  finalText: string;
  finalizationMode: KnowledgeAnswerSettlementV5["finalizationMode"];
  groundingStatus: KnowledgeAnswerSettlementV5["groundingStatus"];
  originalAnswerHash: string;
  outcome: KnowledgeAnswerSettlementV5["outcome"];
  receiptHash: string;
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  selectorContractVersion: 13;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  selectorValidationRepairApplied: boolean;
  selectorValidationRepairCompleted: boolean;
  sessionId: string;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V13;
}>;

export type KnowledgeGroundingEvidenceV14 = Readonly<{
  adaptiveCorrectionApplied: boolean;
  contradictedClaimCount: number;
  correctionCompleted: boolean;
  draftClaimCount: number;
  draftContractVersion: 18;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidenceReceiptHash: string;
  fallbackReason: KnowledgeAnswerFallbackReason | null;
  finalAnswerHash: string;
  finalText: string;
  finalizationMode: KnowledgeAnswerSettlementV5["finalizationMode"];
  groundingStatus: KnowledgeAnswerSettlementV5["groundingStatus"];
  originalAnswerHash: string;
  outcome: KnowledgeAnswerSettlementV5["outcome"];
  receiptHash: string;
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  selectorContractVersion: 14;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  selectorValidationRepairApplied: boolean;
  selectorValidationRepairCompleted: boolean;
  sessionId: string;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V14;
}>;

export type KnowledgeGroundingEvidenceV15 = Readonly<{
  adaptiveCorrectionApplied: boolean;
  contradictedClaimCount: number;
  correctionCompleted: boolean;
  draftClaimCount: number;
  draftContractVersion: 19;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidenceReceiptHash: string;
  fallbackReason: KnowledgeAnswerFallbackReason | null;
  finalAnswerHash: string;
  finalText: string;
  finalizationMode: KnowledgeAnswerSettlementV5["finalizationMode"];
  groundingStatus: KnowledgeAnswerSettlementV5["groundingStatus"];
  originalAnswerHash: string;
  outcome: KnowledgeAnswerSettlementV5["outcome"];
  receiptHash: string;
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  selectorContractVersion: 15;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  selectorValidationRepairApplied: boolean;
  selectorValidationRepairCompleted: boolean;
  sessionId: string;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V15;
}>;

export type KnowledgeGroundingEvidenceV16 = Readonly<{
  adaptiveCorrectionApplied: boolean;
  contradictedClaimCount: number;
  correctionCompleted: boolean;
  coveragePlanner: KnowledgeGroundingOperationEvidenceV8;
  draftClaimCount: number;
  draftContractVersion: 20;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidenceReceiptHash: string;
  fallbackReason: KnowledgeAnswerFallbackReason | null;
  finalAnswerHash: string;
  finalText: string;
  finalizationMode: KnowledgeAnswerSettlementV5["finalizationMode"];
  groundingStatus: KnowledgeAnswerSettlementV5["groundingStatus"];
  originalAnswerHash: string;
  outcome: KnowledgeAnswerSettlementV5["outcome"];
  receiptHash: string;
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  selectorContractVersion: 16;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  selectorValidationRepairApplied: boolean;
  selectorValidationRepairCompleted: boolean;
  sessionId: string;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION;
}>;

export type KnowledgeGroundingOperationEvidenceV17 = Readonly<{
  acceptedRequestHash: string;
  acceptedResultHash: string;
  contractVersion: 1 | 17 | 21;
  durationMs: number;
  operationId: string;
  ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  providerRequestId: string | null;
  purpose: KnowledgeAnswerOperationV21;
  role: "auditor" | "final" | "initial" | "primary" | "repair" | "supplement";
  usage: KnowledgeProviderAttemptUsage;
}>;

export type KnowledgeGroundingEvidenceV17 = Readonly<{
  audit: Readonly<{
    coveredDimensionCount: number;
    dimensionCount: number;
    missingDimensionCount: number;
    payloadHash: string;
    status: "accepted";
  }>;
  contracts: KnowledgeAnswerV21ContractVersions;
  correctionAttempted: boolean;
  correctionSucceeded: boolean;
  contradictedClaimCount: number;
  evidenceReceiptHash: string;
  fallbackReason: KnowledgeAnswerFallbackReason | null;
  finalAnswerHash: string;
  finalText: string;
  finalizationMode: KnowledgeAnswerSettlementV5["finalizationMode"];
  groundingStatus: KnowledgeAnswerSettlementV5["groundingStatus"];
  modelPinFingerprint: string;
  operations: readonly KnowledgeGroundingOperationEvidenceV17[];
  originalAnswerHash: string;
  outcome: KnowledgeAnswerSettlementV5["outcome"];
  providerPinFingerprint: string;
  receiptHash: string;
  requestCoverage: KnowledgeAnswerSettlementV5["requestCoverage"];
  selectorRepairAttempted: boolean;
  selectorRepairSucceeded: boolean;
  sessionId: string;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V17;
}>;

export type KnowledgeGroundingResult =
  | LegacyKnowledgeGroundingResult
  | KnowledgeGroundingEvidenceV7
  | KnowledgeGroundingEvidenceV8
  | KnowledgeGroundingEvidenceV9
  | KnowledgeGroundingEvidenceV10
  | KnowledgeGroundingEvidenceV11
  | KnowledgeGroundingEvidenceV12
  | KnowledgeGroundingEvidenceV13
  | KnowledgeGroundingEvidenceV14
  | KnowledgeGroundingEvidenceV15
  | KnowledgeGroundingEvidenceV16
  | KnowledgeGroundingEvidenceV17;

export class KnowledgeAnswerContractError extends Error {
  readonly code:
    | "knowledge_answer_contract_failed"
    | "knowledge_citation_contract_failed";

  constructor(
    code: KnowledgeAnswerContractError["code"],
    message: string
  ) {
    super(message);
    this.name = "KnowledgeAnswerContractError";
    this.code = code;
  }
}

const statusAnswered = "AIQSA_KB_STATUS=ANSWERED";
const statusInsufficient = "AIQSA_KB_STATUS=INSUFFICIENT_EVIDENCE";
const groupedCitation = /[\[(【]\s*((?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?)(?:\s*(?:[,;&/+]|and|и)\s*(?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?))*)\s*[\])】]/giu;
const citationToken = /K[1-9]\d{0,3}(?:\.[1-9]\d?)?/giu;
const bracketedKnowledgeCandidate = /[\[【]\s*([Kk][0-9][^\]】]{0,63})\s*[\]】]/gu;
const knowledgeCitationPrefix = /^[Kk][0-9]+(?:\.[0-9]+)?(?=$|[^\p{L}\p{M}\p{N}_])/u;
const adjacentDuplicate = /(\[K[1-9]\d{0,3}(?:\.[1-9]\d?)?\])(?:\s*\1)+/giu;
const commaGroupedCitation = /\[\s*(K[1-9]\d{0,3}(?:\.[1-9]\d?)?(?:\s*,\s*K[1-9]\d{0,3}(?:\.[1-9]\d?)?)+)\s*\]/giu;
const fullWidthCitation = /【\s*(K[1-9]\d{0,3}(?:\.[1-9]\d?)?)\s*】/giu;
const providerWrappedCitation = /cite([\s\S]{0,1024}?)/giu;
const providerWrappedHandle = /^(K[1-9]\d{0,3}(?:\.[1-9]\d?)?)/iu;
const providerWrappedBracketedHandle = /^\[\s*(K[1-9]\d{0,3}(?:\.[1-9]\d?)?)\s*\]/iu;
const providerWrappedFullWidthHandle = /^【\s*(K[1-9]\d{0,3}(?:\.[1-9]\d?)?)\s*】/iu;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validOperationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/u.test(value);
}

function validDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 24 * 60 * 60 * 1_000;
}

/** Content-free V7 evidence format for a server-settled version-paired path. */
export function groundSettledKnowledgeAnswerV5(input: Readonly<{
  contracts: KnowledgeAnswerContractVersions;
  draft: Readonly<{
    claimCount: number;
    durationMs: number;
    hash: string;
    operationId: string;
    providerRequestId: string | null;
    usage: KnowledgeProviderAttemptUsage;
  }>;
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  selector: Readonly<{
    durationMs: number;
    hash: string;
    operationId: string;
    providerRequestId: string | null;
    usage: KnowledgeProviderAttemptUsage;
  }>;
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV7 {
  const receiptHash = knowledgeEvidenceReceiptHash(input.evidence);
  if (!knowledgeAnswerContractPairForVersions(input.contracts) ||
    !validOperationId(input.draft.operationId) ||
    !validOperationId(input.selector.operationId) ||
    !/^[0-9a-f]{64}$/u.test(input.draft.hash) ||
    !/^[0-9a-f]{64}$/u.test(input.selector.hash) ||
    !validDuration(input.draft.durationMs) || !validDuration(input.selector.durationMs) ||
    !Number.isSafeInteger(input.draft.claimCount) || input.draft.claimCount < 0 ||
    input.draft.claimCount > 24 || !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted Knowledge grounding operation evidence is invalid"
    );
  }
  return Object.freeze({
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    draftClaimCount: input.draft.claimCount,
    draftContractVersion: input.contracts.draftContractVersion,
    draftHash: input.draft.hash,
    draftOperationId: input.draft.operationId,
    durations: Object.freeze({
      draftMs: input.draft.durationMs,
      selectorMs: input.selector.durationMs
    }),
    evidenceReceiptHash: input.evidenceReceiptHash,
    fallbackReason: input.settlement.fallbackReason,
    finalAnswerHash: hash(input.settlement.finalText),
    finalText: input.settlement.finalText,
    finalizationMode: input.settlement.finalizationMode,
    groundingStatus: input.settlement.groundingStatus,
    originalAnswerHash: input.draft.hash,
    outcome: input.settlement.outcome,
    providerRequestIds: Object.freeze({
      draft: input.draft.providerRequestId,
      selector: input.selector.providerRequestId
    }),
    receiptHash,
    requestCoverage: input.settlement.requestCoverage,
    selectorContractVersion: input.contracts.selectorContractVersion,
    selectorHash: input.selector.hash,
    selectorOperationId: input.selector.operationId,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    usage: Object.freeze({
      draft: input.draft.usage,
      selector: input.selector.usage
    }),
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V7
  });
}

function validGroundingOperationV8(
  operation: KnowledgeGroundingOperationEvidenceV8,
  role: KnowledgeGroundingOperationEvidenceV8["role"],
  claimCountRequired: boolean
): boolean {
  return operation.role === role && validOperationId(operation.operationId) &&
    /^[0-9a-f]{64}$/u.test(operation.hash) && validDuration(operation.durationMs) &&
    (claimCountRequired
      ? Number.isSafeInteger(operation.claimCount) && operation.claimCount !== null &&
        operation.claimCount >= 0 && operation.claimCount <= 24
      : operation.claimCount === null);
}

/** Content-free V8 receipt for the bounded adaptive V12/V8 protocol. The
 * private candidate/verdict text remains in provider-attempt state; this
 * projection records only immutable operation identities, accounting, and the
 * deterministic settlement. */
export function groundSettledKnowledgeAnswerV8(input: Readonly<{
  contracts: Readonly<{ draftContractVersion: 12; selectorContractVersion: 8 }>;
  draftClaimCount: number;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV8 {
  const receiptHash = knowledgeEvidenceReceiptHash(input.evidence);
  const shapeValid = input.drafts.length >= 1 && input.drafts.length <= 2 &&
    input.selectors.length >= 1 && input.selectors.length <= 2 &&
    input.selectors.length <= input.drafts.length &&
    validGroundingOperationV8(input.drafts[0]!, "primary", true) &&
    (input.drafts.length === 1 ||
      validGroundingOperationV8(input.drafts[1]!, "supplement", true)) &&
    validGroundingOperationV8(input.selectors[0]!, "initial", false) &&
    (input.selectors.length === 1 ||
      validGroundingOperationV8(input.selectors[1]!, "final", false));
  if (input.contracts.draftContractVersion !== 12 ||
    input.contracts.selectorContractVersion !== 8 || !shapeValid ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted adaptive Knowledge grounding operation evidence is invalid"
    );
  }
  const drafts = Object.freeze(input.drafts.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectors = Object.freeze(input.selectors.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  return Object.freeze({
    adaptiveCorrectionApplied: drafts.length === 2,
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    correctionCompleted: selectors.length === 2,
    draftClaimCount: input.draftClaimCount,
    draftContractVersion: 12,
    drafts,
    evidenceReceiptHash: input.evidenceReceiptHash,
    fallbackReason: input.settlement.fallbackReason,
    finalAnswerHash: hash(input.settlement.finalText),
    finalText: input.settlement.finalText,
    finalizationMode: input.settlement.finalizationMode,
    groundingStatus: input.settlement.groundingStatus,
    originalAnswerHash: drafts[0]!.hash,
    outcome: input.settlement.outcome,
    receiptHash,
    requestCoverage: input.settlement.requestCoverage,
    selectorContractVersion: 8,
    selectors,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V8
  });
}

/** Content-free V9 receipt for the bounded adaptive V13/V9 atomic-entailment
 * protocol. Its operation shape is intentionally identical to V8; the new
 * receipt version keeps deterministic replay tied to the new contracts. */
export function groundSettledKnowledgeAnswerV9(input: Readonly<{
  contracts: Readonly<{ draftContractVersion: 13; selectorContractVersion: 9 }>;
  draftClaimCount: number;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV9 {
  const receiptHash = knowledgeEvidenceReceiptHash(input.evidence);
  const shapeValid = input.drafts.length >= 1 && input.drafts.length <= 2 &&
    input.selectors.length >= 1 && input.selectors.length <= 2 &&
    input.selectors.length <= input.drafts.length &&
    validGroundingOperationV8(input.drafts[0]!, "primary", true) &&
    (input.drafts.length === 1 ||
      validGroundingOperationV8(input.drafts[1]!, "supplement", true)) &&
    validGroundingOperationV8(input.selectors[0]!, "initial", false) &&
    (input.selectors.length === 1 ||
      validGroundingOperationV8(input.selectors[1]!, "final", false));
  if (input.contracts.draftContractVersion !== 13 ||
    input.contracts.selectorContractVersion !== 9 || !shapeValid ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted atomic-entailment Knowledge grounding operation evidence is invalid"
    );
  }
  const drafts = Object.freeze(input.drafts.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectors = Object.freeze(input.selectors.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  return Object.freeze({
    adaptiveCorrectionApplied: drafts.length === 2,
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    correctionCompleted: selectors.length === 2,
    draftClaimCount: input.draftClaimCount,
    draftContractVersion: 13,
    drafts,
    evidenceReceiptHash: input.evidenceReceiptHash,
    fallbackReason: input.settlement.fallbackReason,
    finalAnswerHash: hash(input.settlement.finalText),
    finalText: input.settlement.finalText,
    finalizationMode: input.settlement.finalizationMode,
    groundingStatus: input.settlement.groundingStatus,
    originalAnswerHash: drafts[0]!.hash,
    outcome: input.settlement.outcome,
    receiptHash,
    requestCoverage: input.settlement.requestCoverage,
    selectorContractVersion: 9,
    selectors,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V9
  });
}

/** Content-free V10 receipt for the bounded adaptive V14/V10
 * required-dimension protocol. The private coverage map stays in accepted
 * provider state; this receipt records only operation identity and settlement. */
export function groundSettledKnowledgeAnswerV10(input: Readonly<{
  contracts: Readonly<{ draftContractVersion: 14; selectorContractVersion: 10 }>;
  draftClaimCount: number;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV10 {
  const receiptHash = knowledgeEvidenceReceiptHash(input.evidence);
  const shapeValid = input.drafts.length >= 1 && input.drafts.length <= 2 &&
    input.selectors.length >= 1 && input.selectors.length <= 2 &&
    input.selectors.length <= input.drafts.length &&
    validGroundingOperationV8(input.drafts[0]!, "primary", true) &&
    (input.drafts.length === 1 ||
      validGroundingOperationV8(input.drafts[1]!, "supplement", true)) &&
    validGroundingOperationV8(input.selectors[0]!, "initial", false) &&
    (input.selectors.length === 1 ||
      validGroundingOperationV8(input.selectors[1]!, "final", false));
  if (input.contracts.draftContractVersion !== 14 ||
    input.contracts.selectorContractVersion !== 10 || !shapeValid ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted required-dimension Knowledge grounding operation evidence is invalid"
    );
  }
  const drafts = Object.freeze(input.drafts.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectors = Object.freeze(input.selectors.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  return Object.freeze({
    adaptiveCorrectionApplied: drafts.length === 2,
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    correctionCompleted: selectors.length === 2,
    draftClaimCount: input.draftClaimCount,
    draftContractVersion: 14,
    drafts,
    evidenceReceiptHash: input.evidenceReceiptHash,
    fallbackReason: input.settlement.fallbackReason,
    finalAnswerHash: hash(input.settlement.finalText),
    finalText: input.settlement.finalText,
    finalizationMode: input.settlement.finalizationMode,
    groundingStatus: input.settlement.groundingStatus,
    originalAnswerHash: drafts[0]!.hash,
    outcome: input.settlement.outcome,
    receiptHash,
    requestCoverage: input.settlement.requestCoverage,
    selectorContractVersion: 10,
    selectors,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V10
  });
}

/** Content-free V11 receipt for V15/V11. A second Draft remains the bounded
 * coverage-correction path. Without that Draft, one second Selector may only
 * be the single contract-validation repair over the immutable primary Draft
 * and evidence. These mutually exclusive shapes make recovery auditable. */
export function groundSettledKnowledgeAnswerV11(input: Readonly<{
  contracts: Readonly<{ draftContractVersion: 15; selectorContractVersion: 11 }>;
  draftClaimCount: number;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV11 {
  const receiptHash = knowledgeEvidenceReceiptHash(input.evidence);
  const primaryValid = input.drafts.length >= 1 && input.drafts.length <= 2 &&
    input.selectors.length >= 1 && input.selectors.length <= 2 &&
    validGroundingOperationV8(input.drafts[0]!, "primary", true) &&
    validGroundingOperationV8(input.selectors[0]!, "initial", false);
  const correctionShape = input.drafts.length === 2 &&
    validGroundingOperationV8(input.drafts[1]!, "supplement", true) &&
    (input.selectors.length === 1 || input.selectors.length === 2 &&
      validGroundingOperationV8(input.selectors[1]!, "final", false));
  const repairShape = input.drafts.length === 1 &&
    (input.selectors.length === 1 || input.selectors.length === 2 &&
      validGroundingOperationV8(input.selectors[1]!, "repair", false));
  const shapeValid = primaryValid && (correctionShape || repairShape);
  if (input.contracts.draftContractVersion !== 15 ||
    input.contracts.selectorContractVersion !== 11 || !shapeValid ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted validation-repair Knowledge grounding operation evidence is invalid"
    );
  }
  const drafts = Object.freeze(input.drafts.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectors = Object.freeze(input.selectors.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectorValidationRepairApplied = selectors[1]?.role === "repair";
  return Object.freeze({
    adaptiveCorrectionApplied: drafts.length === 2,
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    correctionCompleted: selectors[1]?.role === "final",
    draftClaimCount: input.draftClaimCount,
    draftContractVersion: 15,
    drafts,
    evidenceReceiptHash: input.evidenceReceiptHash,
    fallbackReason: input.settlement.fallbackReason,
    finalAnswerHash: hash(input.settlement.finalText),
    finalText: input.settlement.finalText,
    finalizationMode: input.settlement.finalizationMode,
    groundingStatus: input.settlement.groundingStatus,
    originalAnswerHash: drafts[0]!.hash,
    outcome: input.settlement.outcome,
    receiptHash,
    requestCoverage: input.settlement.requestCoverage,
    selectorContractVersion: 11,
    selectors,
    selectorValidationRepairApplied,
    selectorValidationRepairCompleted: selectorValidationRepairApplied,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V11
  });
}

/** Content-free V12 receipt for V16/V12. Quantitative coverage changes only
 * the private generation/adjudication contract; the bounded correction and
 * mutually exclusive validation-repair shapes remain identical to V11. */
export function groundSettledKnowledgeAnswerV12(input: Readonly<{
  contracts: Readonly<{ draftContractVersion: 16; selectorContractVersion: 12 }>;
  draftClaimCount: number;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV12 {
  const receiptHash = knowledgeEvidenceReceiptHash(input.evidence);
  const primaryValid = input.drafts.length >= 1 && input.drafts.length <= 2 &&
    input.selectors.length >= 1 && input.selectors.length <= 2 &&
    validGroundingOperationV8(input.drafts[0]!, "primary", true) &&
    validGroundingOperationV8(input.selectors[0]!, "initial", false);
  const correctionShape = input.drafts.length === 2 &&
    validGroundingOperationV8(input.drafts[1]!, "supplement", true) &&
    (input.selectors.length === 1 || input.selectors.length === 2 &&
      validGroundingOperationV8(input.selectors[1]!, "final", false));
  const repairShape = input.drafts.length === 1 &&
    (input.selectors.length === 1 || input.selectors.length === 2 &&
      validGroundingOperationV8(input.selectors[1]!, "repair", false));
  const shapeValid = primaryValid && (correctionShape || repairShape);
  if (input.contracts.draftContractVersion !== 16 ||
    input.contracts.selectorContractVersion !== 12 || !shapeValid ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted quantitative-coverage Knowledge grounding operation evidence is invalid"
    );
  }
  const drafts = Object.freeze(input.drafts.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectors = Object.freeze(input.selectors.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectorValidationRepairApplied = selectors[1]?.role === "repair";
  return Object.freeze({
    adaptiveCorrectionApplied: drafts.length === 2,
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    correctionCompleted: selectors[1]?.role === "final",
    draftClaimCount: input.draftClaimCount,
    draftContractVersion: 16,
    drafts,
    evidenceReceiptHash: input.evidenceReceiptHash,
    fallbackReason: input.settlement.fallbackReason,
    finalAnswerHash: hash(input.settlement.finalText),
    finalText: input.settlement.finalText,
    finalizationMode: input.settlement.finalizationMode,
    groundingStatus: input.settlement.groundingStatus,
    originalAnswerHash: drafts[0]!.hash,
    outcome: input.settlement.outcome,
    receiptHash,
    requestCoverage: input.settlement.requestCoverage,
    selectorContractVersion: 12,
    selectors,
    selectorValidationRepairApplied,
    selectorValidationRepairCompleted: selectorValidationRepairApplied,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V12
  });
}

/** Content-free V13 receipt for V17/V13. The Selector supplies one semantic
 * representation while the server derives redundant settlement control state;
 * correction and validation-repair operation shapes remain auditable. */
export function groundSettledKnowledgeAnswerV13(input: Readonly<{
  contracts: Readonly<{ draftContractVersion: 17; selectorContractVersion: 13 }>;
  draftClaimCount: number;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV13 {
  const receiptHash = knowledgeEvidenceReceiptHash(input.evidence);
  const primaryValid = input.drafts.length >= 1 && input.drafts.length <= 2 &&
    input.selectors.length >= 1 && input.selectors.length <= 2 &&
    validGroundingOperationV8(input.drafts[0]!, "primary", true) &&
    validGroundingOperationV8(input.selectors[0]!, "initial", false);
  const correctionShape = input.drafts.length === 2 &&
    validGroundingOperationV8(input.drafts[1]!, "supplement", true) &&
    (input.selectors.length === 1 || input.selectors.length === 2 &&
      validGroundingOperationV8(input.selectors[1]!, "final", false));
  const repairShape = input.drafts.length === 1 &&
    (input.selectors.length === 1 || input.selectors.length === 2 &&
      validGroundingOperationV8(input.selectors[1]!, "repair", false));
  const shapeValid = primaryValid && (correctionShape || repairShape);
  if (input.contracts.draftContractVersion !== 17 ||
    input.contracts.selectorContractVersion !== 13 || !shapeValid ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted normalized-selector Knowledge grounding operation evidence is invalid"
    );
  }
  const drafts = Object.freeze(input.drafts.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectors = Object.freeze(input.selectors.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectorValidationRepairApplied = selectors[1]?.role === "repair";
  return Object.freeze({
    adaptiveCorrectionApplied: drafts.length === 2,
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    correctionCompleted: selectors[1]?.role === "final",
    draftClaimCount: input.draftClaimCount,
    draftContractVersion: 17,
    drafts,
    evidenceReceiptHash: input.evidenceReceiptHash,
    fallbackReason: input.settlement.fallbackReason,
    finalAnswerHash: hash(input.settlement.finalText),
    finalText: input.settlement.finalText,
    finalizationMode: input.settlement.finalizationMode,
    groundingStatus: input.settlement.groundingStatus,
    originalAnswerHash: drafts[0]!.hash,
    outcome: input.settlement.outcome,
    receiptHash,
    requestCoverage: input.settlement.requestCoverage,
    selectorContractVersion: 13,
    selectors,
    selectorValidationRepairApplied,
    selectorValidationRepairCompleted: selectorValidationRepairApplied,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V13
  });
}

/** Content-free V14 receipt for Draft V18 / Selector V14. The Selector emits
 * coverage first and only semantic primitives; settlement control state stays
 * server-derived while correction and validation-repair shapes remain auditable. */
export function groundSettledKnowledgeAnswerV14(input: Readonly<{
  contracts: Readonly<{ draftContractVersion: 18; selectorContractVersion: 14 }>;
  draftClaimCount: number;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV14 {
  const receiptHash = knowledgeEvidenceReceiptHash(input.evidence);
  const primaryValid = input.drafts.length >= 1 && input.drafts.length <= 2 &&
    input.selectors.length >= 1 && input.selectors.length <= 2 &&
    validGroundingOperationV8(input.drafts[0]!, "primary", true) &&
    validGroundingOperationV8(input.selectors[0]!, "initial", false);
  const correctionShape = input.drafts.length === 2 &&
    validGroundingOperationV8(input.drafts[1]!, "supplement", true) &&
    (input.selectors.length === 1 || input.selectors.length === 2 &&
      validGroundingOperationV8(input.selectors[1]!, "final", false));
  const repairShape = input.drafts.length === 1 &&
    (input.selectors.length === 1 || input.selectors.length === 2 &&
      validGroundingOperationV8(input.selectors[1]!, "repair", false));
  const shapeValid = primaryValid && (correctionShape || repairShape);
  if (input.contracts.draftContractVersion !== 18 ||
    input.contracts.selectorContractVersion !== 14 || !shapeValid ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted coverage-first Knowledge grounding operation evidence is invalid"
    );
  }
  const drafts = Object.freeze(input.drafts.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectors = Object.freeze(input.selectors.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectorValidationRepairApplied = selectors[1]?.role === "repair";
  return Object.freeze({
    adaptiveCorrectionApplied: drafts.length === 2,
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    correctionCompleted: selectors[1]?.role === "final",
    draftClaimCount: input.draftClaimCount,
    draftContractVersion: 18,
    drafts,
    evidenceReceiptHash: input.evidenceReceiptHash,
    fallbackReason: input.settlement.fallbackReason,
    finalAnswerHash: hash(input.settlement.finalText),
    finalText: input.settlement.finalText,
    finalizationMode: input.settlement.finalizationMode,
    groundingStatus: input.settlement.groundingStatus,
    originalAnswerHash: drafts[0]!.hash,
    outcome: input.settlement.outcome,
    receiptHash,
    requestCoverage: input.settlement.requestCoverage,
    selectorContractVersion: 14,
    selectors,
    selectorValidationRepairApplied,
    selectorValidationRepairCompleted: selectorValidationRepairApplied,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V14
  });
}

/** Content-free V15 receipt for the phased Draft V19 / Selector V15 path. */
export function groundSettledKnowledgeAnswerV15(input: Readonly<{
  contracts: Readonly<{ draftContractVersion: 19; selectorContractVersion: 15 }>;
  draftClaimCount: number;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV15 {
  const receiptHash = knowledgeEvidenceReceiptHash(input.evidence);
  const primaryValid = input.drafts.length >= 1 && input.drafts.length <= 2 &&
    input.selectors.length >= 1 && input.selectors.length <= 2 &&
    validGroundingOperationV8(input.drafts[0]!, "primary", true) &&
    validGroundingOperationV8(input.selectors[0]!, "initial", false);
  const correctionShape = input.drafts.length === 2 &&
    validGroundingOperationV8(input.drafts[1]!, "supplement", true) &&
    (input.selectors.length === 1 || input.selectors.length === 2 &&
      validGroundingOperationV8(input.selectors[1]!, "final", false));
  const repairShape = input.drafts.length === 1 &&
    (input.selectors.length === 1 || input.selectors.length === 2 &&
      validGroundingOperationV8(input.selectors[1]!, "repair", false));
  const shapeValid = primaryValid && (correctionShape || repairShape);
  if (input.contracts.draftContractVersion !== 19 ||
    input.contracts.selectorContractVersion !== 15 || !shapeValid ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted phased-coverage Knowledge grounding operation evidence is invalid"
    );
  }
  const drafts = Object.freeze(input.drafts.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectors = Object.freeze(input.selectors.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectorValidationRepairApplied = selectors[1]?.role === "repair";
  return Object.freeze({
    adaptiveCorrectionApplied: drafts.length === 2,
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    correctionCompleted: selectors[1]?.role === "final",
    draftClaimCount: input.draftClaimCount,
    draftContractVersion: 19,
    drafts,
    evidenceReceiptHash: input.evidenceReceiptHash,
    fallbackReason: input.settlement.fallbackReason,
    finalAnswerHash: hash(input.settlement.finalText),
    finalText: input.settlement.finalText,
    finalizationMode: input.settlement.finalizationMode,
    groundingStatus: input.settlement.groundingStatus,
    originalAnswerHash: drafts[0]!.hash,
    outcome: input.settlement.outcome,
    receiptHash,
    requestCoverage: input.settlement.requestCoverage,
    selectorContractVersion: 15,
    selectors,
    selectorValidationRepairApplied,
    selectorValidationRepairCompleted: selectorValidationRepairApplied,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V15
  });
}

/** Content-free V16 receipt for the immutable Coverage Planner followed by
 * Draft V20 and Selector V16. The plan text remains private provider-attempt
 * state; this receipt records only the planner operation identity and usage. */
export function groundSettledKnowledgeAnswerV16(input: Readonly<{
  contracts: Readonly<{ draftContractVersion: 20; selectorContractVersion: 16 }>;
  coveragePlanner: KnowledgeGroundingOperationEvidenceV8;
  draftClaimCount: number;
  drafts: readonly KnowledgeGroundingOperationEvidenceV8[];
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  selectors: readonly KnowledgeGroundingOperationEvidenceV8[];
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV16 {
  const receiptHash = knowledgeEvidenceReceiptHash(input.evidence);
  const primaryValid = input.drafts.length >= 1 && input.drafts.length <= 2 &&
    input.selectors.length >= 1 && input.selectors.length <= 2 &&
    validGroundingOperationV8(input.coveragePlanner, "planner", false) &&
    validGroundingOperationV8(input.drafts[0]!, "primary", true) &&
    validGroundingOperationV8(input.selectors[0]!, "initial", false);
  const correctionShape = input.drafts.length === 2 &&
    validGroundingOperationV8(input.drafts[1]!, "supplement", true) &&
    (input.selectors.length === 1 || input.selectors.length === 2 &&
      validGroundingOperationV8(input.selectors[1]!, "final", false));
  const repairShape = input.drafts.length === 1 &&
    (input.selectors.length === 1 || input.selectors.length === 2 &&
      validGroundingOperationV8(input.selectors[1]!, "repair", false));
  const shapeValid = primaryValid && (correctionShape || repairShape);
  if (input.contracts.draftContractVersion !== 20 ||
    input.contracts.selectorContractVersion !== 16 || !shapeValid ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted planned-coverage Knowledge grounding operation evidence is invalid"
    );
  }
  const coveragePlanner = Object.freeze({
    ...input.coveragePlanner,
    usage: Object.freeze({ ...input.coveragePlanner.usage })
  });
  const drafts = Object.freeze(input.drafts.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectors = Object.freeze(input.selectors.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  const selectorValidationRepairApplied = selectors[1]?.role === "repair";
  return Object.freeze({
    adaptiveCorrectionApplied: drafts.length === 2,
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    correctionCompleted: selectors[1]?.role === "final",
    coveragePlanner,
    draftClaimCount: input.draftClaimCount,
    draftContractVersion: 20,
    drafts,
    evidenceReceiptHash: input.evidenceReceiptHash,
    fallbackReason: input.settlement.fallbackReason,
    finalAnswerHash: hash(input.settlement.finalText),
    finalText: input.settlement.finalText,
    finalizationMode: input.settlement.finalizationMode,
    groundingStatus: input.settlement.groundingStatus,
    originalAnswerHash: drafts[0]!.hash,
    outcome: input.settlement.outcome,
    receiptHash,
    requestCoverage: input.settlement.requestCoverage,
    selectorContractVersion: 16,
    selectors,
    selectorValidationRepairApplied,
    selectorValidationRepairCompleted: selectorValidationRepairApplied,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION
  });
}

function validGroundingOperationV17(
  operation: KnowledgeGroundingOperationEvidenceV17,
  ordinal: number,
  role: KnowledgeGroundingOperationEvidenceV17["role"]
): boolean {
  const purpose = role === "primary"
    ? KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
    : role === "initial" || role === "repair"
      ? KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17
      : role === "auditor"
        ? KNOWLEDGE_COVERAGE_AUDITOR_OPERATION
        : role === "supplement"
          ? KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
          : KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17;
  const contractVersion = role === "primary" || role === "supplement"
    ? 21
    : role === "auditor"
      ? 1
      : 17;
  return operation.ordinal === ordinal && operation.role === role &&
    operation.purpose === purpose && operation.contractVersion === contractVersion &&
    validOperationId(operation.operationId) && validDuration(operation.durationMs) &&
    /^[0-9a-f]{64}$/u.test(operation.acceptedRequestHash) &&
    /^[0-9a-f]{64}$/u.test(operation.acceptedResultHash) &&
    (operation.providerRequestId === null || operation.providerRequestId.length <= 1_024);
}

/** Content-free V17 provenance for the audited V21 protocol. Private Draft,
 * verdict, Audit dimension, and answer text are excluded by the repository
 * projection; only bounded operation hashes, counts, pins, and settlement
 * aggregates are persisted. */
export function groundSettledKnowledgeAnswerV17(input: Readonly<{
  audit: Readonly<{
    coveredDimensionCount: number;
    dimensionCount: number;
    missingDimensionCount: number;
    payloadHash: string;
  }>;
  contracts: KnowledgeAnswerV21ContractVersions;
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  modelPinFingerprint: string;
  operations: readonly KnowledgeGroundingOperationEvidenceV17[];
  providerPinFingerprint: string;
  selectorRepairSucceeded: boolean;
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV17 {
  const roleSequences: readonly (readonly KnowledgeGroundingOperationEvidenceV17["role"][])[] = [
    ["primary", "initial", "auditor"],
    ["primary", "initial", "auditor", "supplement"],
    ["primary", "initial", "auditor", "supplement", "final"],
    ["primary", "initial", "repair", "auditor"],
    ["primary", "initial", "repair", "auditor", "supplement"],
    ["primary", "initial", "repair", "auditor", "supplement", "final"]
  ];
  const roles = input.operations.map(({ role }) => role);
  const validSequence = roleSequences.some((sequence) =>
    JSON.stringify(sequence) === JSON.stringify(roles));
  const operationsValid = validSequence && input.operations.every((operation, index) =>
    validGroundingOperationV17(operation, index + 1, roles[index]!));
  const auditor = input.operations.find(({ role }) => role === "auditor");
  const correctionAttempted = roles.includes("supplement");
  const correctionSucceeded = roles.includes("final");
  const selectorRepairAttempted = roles.includes("repair");
  const supportedContentCount = input.settlement.supportedClaimCount +
    (input.settlement.finalizationMode === "evidence_only" ||
      input.settlement.finalizationMode === "selected_claims_with_evidence" ? 1 : 0);
  const auditCoverage = supportedContentCount === 0 ||
    input.audit.coveredDimensionCount === 0
    ? "none"
    : input.audit.missingDimensionCount === 0
      ? "complete"
      : "partial";
  const settlementCoverageValid = correctionSucceeded
    ? supportedContentCount === 0
      ? input.settlement.requestCoverage === "none"
      : input.settlement.requestCoverage === "partial" ||
        input.settlement.requestCoverage === "complete"
    : input.settlement.requestCoverage === auditCoverage;
  if (input.contracts.draftContractVersion !== 21 ||
    input.contracts.selectorContractVersion !== 17 ||
    input.contracts.coverageAuditorContractVersion !== 1 ||
    input.contracts.settlementVersion !== 6 || !operationsValid || !auditor ||
    input.audit.payloadHash !== auditor.acceptedResultHash ||
    !Number.isSafeInteger(input.audit.dimensionCount) ||
    input.audit.dimensionCount < 1 || input.audit.dimensionCount > 8 ||
    !Number.isSafeInteger(input.audit.coveredDimensionCount) ||
    input.audit.coveredDimensionCount < 0 ||
    !Number.isSafeInteger(input.audit.missingDimensionCount) ||
    input.audit.missingDimensionCount < 0 ||
    input.audit.coveredDimensionCount + input.audit.missingDimensionCount !==
      input.audit.dimensionCount || input.selectorRepairSucceeded &&
      !selectorRepairAttempted || correctionSucceeded && !correctionAttempted ||
    correctionAttempted && input.audit.missingDimensionCount === 0 ||
    !settlementCoverageValid ||
    !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash) ||
    !/^[0-9a-f]{64}$/u.test(input.modelPinFingerprint) ||
    !/^[0-9a-f]{64}$/u.test(input.providerPinFingerprint)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted audited Knowledge grounding operation evidence is invalid"
    );
  }
  const operations = Object.freeze(input.operations.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  return Object.freeze({
    audit: Object.freeze({
      ...input.audit,
      status: "accepted" as const
    }),
    contracts: Object.freeze({ ...input.contracts }),
    correctionAttempted,
    correctionSucceeded,
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    evidenceReceiptHash: input.evidenceReceiptHash,
    fallbackReason: input.settlement.fallbackReason,
    finalAnswerHash: hash(input.settlement.finalText),
    finalText: input.settlement.finalText,
    finalizationMode: input.settlement.finalizationMode,
    groundingStatus: input.settlement.groundingStatus,
    modelPinFingerprint: input.modelPinFingerprint,
    operations,
    originalAnswerHash: input.operations[0]!.acceptedResultHash,
    outcome: input.settlement.outcome,
    providerPinFingerprint: input.providerPinFingerprint,
    receiptHash: knowledgeEvidenceReceiptHash(input.evidence),
    requestCoverage: input.settlement.requestCoverage,
    selectorRepairAttempted,
    selectorRepairSucceeded: input.selectorRepairSucceeded,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V17
  });
}

function normalizeToolLoopCitationSyntax(
  value: string,
  availableHandles: ReadonlySet<string>
): string {
  return normalizeProviderWrappedCitations(value, availableHandles)
    .replace(commaGroupedCitation, (match, body: string) => {
      const handles = body.split(",").map((handle) => handle.trim().toUpperCase());
      return handles.every((handle) => availableHandles.has(handle))
        ? handles.map((handle) => `[${handle}]`).join("")
        : match;
    })
    .replace(fullWidthCitation, (match, handle: string) => {
      const normalized = handle.toUpperCase();
      return availableHandles.has(normalized) ? `[${normalized}]` : match;
    })
    .replace(adjacentDuplicate, "$1");
}

function normalizeProviderWrappedCitations(
  value: string,
  availableHandles: ReadonlySet<string>
): string {
  const normalized = value.replace(providerWrappedCitation, (_match, rawBody: string) => {
    let body = rawBody.trim();
    const handles: string[] = [];
    while (body.trim().length > 0) {
      const prefix = handles.length === 0
        ? /^\s*/u.exec(body)
        : /^(?:\s*\s*|\s*(?:[,;&/+]|and\b|и\b)\s*(?:\s*)?|\s+)/iu.exec(body);
      if (!prefix) {
        throw new KnowledgeAnswerContractError(
          "knowledge_citation_contract_failed",
          "The provider returned a malformed citation wrapper"
        );
      }
      body = body.slice(prefix[0].length);
      const handleMatch = providerWrappedBracketedHandle.exec(body) ??
        providerWrappedFullWidthHandle.exec(body) ?? providerWrappedHandle.exec(body);
      const handle = handleMatch?.[1]?.toUpperCase();
      if (!handleMatch || !handle) {
        throw new KnowledgeAnswerContractError(
          "knowledge_citation_contract_failed",
          "The provider returned a malformed citation wrapper"
        );
      }
      handles.push(handle);
      body = body.slice(handleMatch[0].length);
    }
    if (handles.length < 1 || handles.some((handle) => !availableHandles.has(handle))) {
      throw new KnowledgeAnswerContractError(
        "knowledge_citation_contract_failed",
        "The provider citation wrapper referenced evidence outside the final manifest"
      );
    }
    return handles.map((handle) => `[${handle}]`).join("");
  });
  if (normalized.includes("cite") || normalized.includes("") ||
    normalized.includes("")) {
    throw new KnowledgeAnswerContractError(
      "knowledge_citation_contract_failed",
      "The provider returned a malformed citation wrapper"
    );
  }
  return normalized;
}

function containsEvidenceInternalIdentity(
  answer: string,
  evidence: KnowledgeEvidencePackage
): boolean {
  const sentinels = [
    evidence.runId,
    evidence.sessionId,
    ...evidence.items.flatMap((item) => [
      item.id,
      item.knowledgeBaseId,
      item.sourceId,
      item.sourceVersionId,
      item.sourceArtifactId,
      item.documentId,
      item.documentVersionId,
      item.sectionId,
      item.passageId,
      item.contentHash
    ])
  ].filter((entry): entry is string => Boolean(entry && entry.length >= 8));
  return sentinels.some((entry) => answer.includes(entry));
}

function normalizeCitationSyntax(
  value: string,
  availableHandles: ReadonlySet<string>
): string {
  const wrapped = normalizeProviderWrappedCitations(value, availableHandles);
  const grouped = wrapped.replace(groupedCitation, (match, body: string) => {
    const handles = body.match(citationToken)?.map((handle) => handle.toUpperCase()) ?? [];
    return handles.length > 0 && handles.every((handle) => decodeKnowledgeCitationHandle(handle))
      ? handles.map((handle) => `[${handle}]`).join("")
      : match;
  });
  return grouped.replace(adjacentDuplicate, "$1");
}

function assertNoMalformedOrUnknownHandles(
  answer: string,
  availableHandles: ReadonlySet<string>
): string[] {
  const seen: string[] = [];
  for (const match of answer.matchAll(bracketedKnowledgeCandidate)) {
    const candidate = match[1]?.trim() ?? "";
    if (!knowledgeCitationPrefix.test(candidate)) continue;
    const raw = candidate.toUpperCase();
    const decoded = decodeKnowledgeCitationHandle(raw);
    if (!decoded || !availableHandles.has(raw)) {
      throw new KnowledgeAnswerContractError(
        "knowledge_citation_contract_failed",
        "The Knowledge answer cited a handle outside the final evidence manifest"
      );
    }
    seen.push(raw);
  }
  return seen;
}

/**
 * Structural-only answer settlement. It validates the exact status line and
 * final-manifest handles; it never scores prose, guesses support, calls a
 * model, retries, or rewrites answer content.
 */
export function groundKnowledgeAnswer(input: Readonly<{
  answer: string;
  evidence: KnowledgeEvidencePackage;
}>): KnowledgeGroundingResult {
  const original = input.answer.replace(/\r\n?/gu, "\n");
  const newline = original.indexOf("\n");
  const status = newline < 0 ? original : original.slice(0, newline);
  if (status !== statusAnswered && status !== statusInsufficient) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      status.startsWith("AIQSA_KB_STATUS=")
        ? "The Knowledge answer returned an unknown status"
        : "The Knowledge answer omitted the required status line"
    );
  }
  const body = newline < 0 ? "" : original.slice(newline + 1);
  if (!body.trim() || containsEvidenceInternalIdentity(body, input.evidence)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      !body.trim()
        ? "The Knowledge answer body is empty"
        : "The Knowledge answer leaked an internal identity"
    );
  }
  const availableHandles = new Set(
    input.evidence.items
      .filter((item) => item.state === "available" && item.excerpt !== null)
      .map((item) => item.handle)
  );
  const normalizedBody = normalizeCitationSyntax(body, availableHandles);
  const handles = assertNoMalformedOrUnknownHandles(normalizedBody, availableHandles);
  if (status === statusAnswered && handles.length < 1) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "An answered Knowledge response requires a final-manifest citation"
    );
  }
  const answered = status === statusAnswered;
  return Object.freeze({
    finalAnswerHash: hash(normalizedBody),
    finalText: normalizedBody,
    originalAnswerHash: hash(input.answer),
    outcome: answered ? "answered" : "insufficient_evidence",
    receiptHash: knowledgeEvidenceReceiptHash(input.evidence),
    sessionId: input.evidence.sessionId,
    version: KNOWLEDGE_GROUNDING_VERSION
  });
}

/**
 * Structural settlement for the ordinary answer-model tool loop. It keeps the
 * answer as ordinary Markdown and only normalizes an unambiguous comma-group
 * whose every handle belongs to provider-visible, still-available evidence.
 */
export function groundKnowledgeToolLoopAnswer(input: Readonly<{
  answer: string;
  evidence: KnowledgeEvidencePackage;
}>): KnowledgeGroundingResult {
  const original = input.answer.replace(/\r\n?/gu, "\n");
  if (!original.trim() || containsEvidenceInternalIdentity(original, input.evidence)) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      !original.trim()
        ? "The answer body is empty"
        : "The answer leaked an internal Knowledge identity"
    );
  }
  const availableHandles = new Set(
    input.evidence.items
      .filter((item) => item.state === "available" && item.excerpt !== null)
      .map((item) => item.handle)
  );
  const finalText = normalizeToolLoopCitationSyntax(original, availableHandles);
  assertNoMalformedOrUnknownHandles(finalText, availableHandles);
  return Object.freeze({
    finalAnswerHash: hash(finalText),
    finalText,
    originalAnswerHash: hash(input.answer),
    outcome: "answered",
    receiptHash: knowledgeEvidenceReceiptHash(input.evidence),
    sessionId: input.evidence.sessionId,
    version: KNOWLEDGE_GROUNDING_VERSION
  });
}
