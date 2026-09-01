import { createHash } from "node:crypto";
import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import {
  knowledgeEvidenceReceiptHash,
  type KnowledgeEvidencePackage
} from "./evidencePackage";
import {
  knowledgeAnswerContractPairForVersions,
  knowledgeAnswerHash,
  type KnowledgeAnswerContractVersions,
  type KnowledgeAnswerFallbackReason,
  type KnowledgeAnswerSettlementV5
} from "./answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
  KNOWLEDGE_ANSWER_SCOPE_V6_CLOSURE_MAX_OPERATION_COUNT_V1,
  KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2,
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
  knowledgeAnswerScopeV6CorrectionFitsV2,
  type KnowledgeAnswerOperationScopeV3,
  type KnowledgeAnswerOperationScopeV4,
  type KnowledgeAnswerOperationScopeV5,
  type KnowledgeAnswerOperationScopeV6,
  type KnowledgeAnswerOperationScopeV6CompletenessV1,
  type KnowledgeAnswerOperationScopeV6ClosureV1,
  type KnowledgeAnswerOperationScopeV6ClosureV2,
  type KnowledgeAnswerOperationAuditV2,
  type KnowledgeAnswerV21AuditV2ContractVersions,
  type KnowledgeAnswerV21ContractVersions,
  type KnowledgeAnswerV21ScopeV5ContractVersions,
  type KnowledgeAnswerV21ScopeV4ContractVersions,
  type KnowledgeAnswerV21ScopeV3ContractVersions
} from "./answerGroundingV21";
import { KNOWLEDGE_COVERAGE_AUDITOR_OPERATION } from "./coverageAuditV2";
import { KNOWLEDGE_COVERAGE_SCOPE_OPERATION } from "./coverageScopeV3";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V18,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V18
} from "./answerGroundingSelectorV18";
import { KNOWLEDGE_COVERAGE_SCOPE_V4_OPERATION } from "./coverageScopeV4";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V19,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V19
} from "./answerGroundingSelectorV19";
import { KNOWLEDGE_COVERAGE_SCOPE_V5_OPERATION } from "./coverageScopeV5";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V20,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V20
} from "./answerGroundingSelectorV20";
import { KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION } from "./coverageScopeV6";
import {
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
} from "./coverageScopeCompletenessV1";
import {
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
} from "./coverageScopeClosureV1";
import {
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_V2_OPERATION
} from "./coverageScopeClosureV2";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
} from "./answerGroundingSelectorV21";
import {
  decodeKnowledgeProviderAttemptUsage,
  type KnowledgeProviderAttemptUsage
} from "./evidenceDispatchRepository";
import {
  decodeKnowledgeGroundingEffectiveExecutionPolicyV1,
  type KnowledgeGroundingEffectiveExecutionPolicyV1
} from "./groundingExecutionPolicy";

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
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V18 = 18 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V19 = 19 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V20 = 20 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V21 = 21 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V22 = 22 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V23 = 23 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V24 = 24 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V25 = 25 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V26 = 26 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V27 = 27 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V28 = 28 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V29 = 29 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V30 = 30 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V31 = 31 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V32 = 32 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V33 = 33 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V34 = 34 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V35 = 35 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V36 = 36 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V37 = 37 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V38 = 38 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V39 = 39 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V40 = 40 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V41 = 41 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V42 = 42 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V43 = 43 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V44 = 44 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V45 = 45 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V46 = 46 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V47 = 47 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V48 = 48 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V49 = 49 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V50 = 50 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V51 = 51 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V52 = 52 as const;
export const KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V53 = 53 as const;

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
  contractVersion: 1 | 2 | 17 | 21;
  durationMs: number;
  operationId: string;
  ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  providerRequestId: string | null;
  purpose: KnowledgeAnswerOperationAuditV2;
  role: "auditor" | "auditor_repair" | "final" | "initial" | "primary" |
    "repair" | "supplement";
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
  contracts: KnowledgeAnswerV21AuditV2ContractVersions;
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

export type KnowledgeGroundingEvidenceV18 = Omit<
  KnowledgeGroundingEvidenceV17,
  "version"
> & Readonly<{
  answerBindingFingerprint: string;
  draftClaimCount: number;
  executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1;
  executionPolicyFingerprint: string;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V18;
}>;

export type KnowledgeGroundingOperationEvidenceV19 = Readonly<{
  acceptedRequestHash: string;
  acceptedResultHash: string;
  contractVersion: 3 | 18 | 21;
  durationMs: number;
  operationId: string;
  ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  providerRequestId: string | null;
  purpose: KnowledgeAnswerOperationScopeV3;
  role: "final" | "initial" | "primary" | "repair" | "scope" |
    "scope_repair" | "supplement";
  usage: KnowledgeProviderAttemptUsage;
}>;

export type KnowledgeGroundingEvidenceV19 = Omit<
  KnowledgeGroundingEvidenceV18,
  "audit" | "contracts" | "operations" | "version"
> & Readonly<{
  contracts: KnowledgeAnswerV21ScopeV3ContractVersions;
  coverage: Readonly<{
    coveredDimensionCount: number;
    missingDimensionCount: number;
    selectorPayloadHash: string;
    status: "accepted";
  }>;
  coverageScope: Readonly<{
    dimensionCount: number;
    payloadHash: string;
    status: "accepted";
  }>;
  operations: readonly KnowledgeGroundingOperationEvidenceV19[];
  scopeRepairAttempted: boolean;
  scopeRepairSucceeded: boolean;
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V19;
}>;

export type KnowledgeGroundingOperationEvidenceV20 = Readonly<{
  acceptedRequestHash: string;
  acceptedResultHash: string;
  contractVersion: 4 | 19 | 21;
  durationMs: number;
  operationId: string;
  ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  providerRequestId: string | null;
  purpose: KnowledgeAnswerOperationScopeV4;
  role: KnowledgeGroundingOperationEvidenceV19["role"];
  usage: KnowledgeProviderAttemptUsage;
}>;

export type KnowledgeGroundingEvidenceV20 = Omit<
  KnowledgeGroundingEvidenceV19,
  "contracts" | "operations" | "version"
> & Readonly<{
  contracts: KnowledgeAnswerV21ScopeV4ContractVersions;
  operations: readonly KnowledgeGroundingOperationEvidenceV20[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V20;
}>;

export type KnowledgeGroundingOperationEvidenceV21 = Readonly<{
  acceptedRequestHash: string;
  acceptedResultHash: string;
  contractVersion: 5 | 20 | 21;
  durationMs: number;
  operationId: string;
  ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  providerRequestId: string | null;
  purpose: KnowledgeAnswerOperationScopeV5;
  role: KnowledgeGroundingOperationEvidenceV20["role"];
  usage: KnowledgeProviderAttemptUsage;
}>;

export type KnowledgeGroundingEvidenceV21 = Omit<
  KnowledgeGroundingEvidenceV20,
  "contracts" | "operations" | "version"
> & Readonly<{
  contracts: KnowledgeAnswerV21ScopeV5ContractVersions;
  operations: readonly KnowledgeGroundingOperationEvidenceV21[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V21;
}>;

export type KnowledgeGroundingOperationEvidenceV22 = Readonly<{
  acceptedRequestHash: string;
  acceptedResultHash: string;
  contractVersion: 6 | 21;
  durationMs: number;
  operationId: string;
  ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  providerRequestId: string | null;
  purpose: KnowledgeAnswerOperationScopeV6;
  role: KnowledgeGroundingOperationEvidenceV21["role"];
  usage: KnowledgeProviderAttemptUsage;
}>;

export type KnowledgeGroundingEvidenceV22 = Omit<
  KnowledgeGroundingEvidenceV21,
  "contracts" | "operations" | "version"
> & Readonly<{
  contracts: KnowledgeAnswerV21ContractVersions;
  operations: readonly KnowledgeGroundingOperationEvidenceV22[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V22;
}>;

export type KnowledgeGroundingOperationEvidenceV23 =
  KnowledgeGroundingOperationEvidenceV22;

export type KnowledgeGroundingEvidenceV23 = Omit<
  KnowledgeGroundingEvidenceV22,
  "coverage" | "operations" | "version"
> & Readonly<{
  coverage: Readonly<{
    coveredDimensionCount: number;
    excludedDimensionCount: number;
    missingDimensionCount: number;
    selectorPayloadHash: string;
    status: "accepted";
  }>;
  operations: readonly KnowledgeGroundingOperationEvidenceV23[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V23;
}>;

export type KnowledgeGroundingOperationEvidenceV24 = Readonly<{
  acceptedRequestHash: string;
  acceptedResultHash: string;
  contractVersion: 1 | 6 | 21;
  durationMs: number;
  operationId: string;
  ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  providerRequestId: string | null;
  purpose: KnowledgeAnswerOperationScopeV6CompletenessV1;
  role: KnowledgeGroundingOperationEvidenceV23["role"] |
    "scope_completeness" | "scope_completeness_repair";
  usage: KnowledgeProviderAttemptUsage;
}>;

export type KnowledgeGroundingEvidenceV24 = Omit<
  KnowledgeGroundingEvidenceV23,
  "operations" | "version"
> & Readonly<{
  completeness: Readonly<{
    addedDimensionCount: number;
    initialDimensionCount: number;
    initialScopePayloadHash: string;
    payloadHash: string;
    status: "accepted";
  }>;
  completenessRepairAttempted: boolean;
  completenessRepairSucceeded: boolean;
  operations: readonly KnowledgeGroundingOperationEvidenceV24[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V24;
}>;

export type KnowledgeGroundingOperationEvidenceV25 = Omit<
  KnowledgeGroundingOperationEvidenceV24,
  "ordinal"
> & Readonly<{
  ordinal: 1 | 2 | 3 | 4 | 5 | 6 | 7;
}>;

type KnowledgeGroundingOperationEvidenceRepairBudgetV2 = Omit<
  KnowledgeGroundingOperationEvidenceV24,
  "ordinal"
> & Readonly<{
  ordinal: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}>;

export type KnowledgeGroundingEvidenceV25 = Omit<
  KnowledgeGroundingEvidenceV24,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV25[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V25;
}>;

export type KnowledgeGroundingOperationEvidenceV26 =
  KnowledgeGroundingOperationEvidenceV25;

export type KnowledgeGroundingEvidenceV26 = Omit<
  KnowledgeGroundingEvidenceV25,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV26[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V26;
}>;

export type KnowledgeGroundingOperationEvidenceV27 =
  KnowledgeGroundingOperationEvidenceV26;

export type KnowledgeGroundingEvidenceV27 = Omit<
  KnowledgeGroundingEvidenceV26,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV27[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V27;
}>;

export type KnowledgeGroundingOperationEvidenceV28 =
  KnowledgeGroundingOperationEvidenceV27;

export type KnowledgeGroundingEvidenceV28 = Omit<
  KnowledgeGroundingEvidenceV27,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV28[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V28;
}>;

export type KnowledgeGroundingOperationEvidenceV29 =
  KnowledgeGroundingOperationEvidenceV28;

export type KnowledgeGroundingEvidenceV29 = Omit<
  KnowledgeGroundingEvidenceV28,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV29[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V29;
}>;

export type KnowledgeGroundingOperationEvidenceV30 =
  KnowledgeGroundingOperationEvidenceV29;

export type KnowledgeGroundingEvidenceV30 = Omit<
  KnowledgeGroundingEvidenceV29,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV30[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V30;
}>;

export type KnowledgeGroundingOperationEvidenceV31 =
  KnowledgeGroundingOperationEvidenceV30;

export type KnowledgeGroundingEvidenceV31 = Omit<
  KnowledgeGroundingEvidenceV30,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV31[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V31;
}>;

export type KnowledgeGroundingOperationEvidenceV32 =
  KnowledgeGroundingOperationEvidenceV31;

export type KnowledgeGroundingEvidenceV32 = Omit<
  KnowledgeGroundingEvidenceV31,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV32[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V32;
}>;

export type KnowledgeGroundingOperationEvidenceV33 =
  KnowledgeGroundingOperationEvidenceV32;

export type KnowledgeGroundingEvidenceV33 = Omit<
  KnowledgeGroundingEvidenceV32,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV33[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V33;
}>;

export type KnowledgeGroundingOperationEvidenceV34 = Omit<
  KnowledgeGroundingOperationEvidenceV33,
  "purpose" | "role"
> & Readonly<{
  purpose: KnowledgeAnswerOperationScopeV6ClosureV1;
  role: KnowledgeGroundingOperationEvidenceV33["role"] |
    "scope_closure" | "scope_closure_repair";
}>;

export type KnowledgeGroundingEvidenceV34 = Omit<
  KnowledgeGroundingEvidenceV33,
  "operations" | "version"
> & Readonly<{
  closure: Readonly<{
    initialCoveredDimensionCount: number;
    payloadHash: string;
    reopenedDimensionCount: number;
    status: "accepted";
  }> | null;
  closureRepairAttempted: boolean;
  closureRepairSucceeded: boolean;
  operations: readonly KnowledgeGroundingOperationEvidenceV34[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V34;
}>;

export type KnowledgeGroundingOperationEvidenceV35 = Omit<
  KnowledgeGroundingOperationEvidenceV34,
  "ordinal"
> & Readonly<{
  ordinal: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}>;

export type KnowledgeGroundingEvidenceV35 = Omit<
  KnowledgeGroundingEvidenceV34,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV35[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V35;
}>;

export type KnowledgeGroundingOperationEvidenceV36 =
  KnowledgeGroundingOperationEvidenceV35;

export type KnowledgeGroundingEvidenceV36 = Omit<
  KnowledgeGroundingEvidenceV35,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV36[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V36;
}>;

export type KnowledgeGroundingOperationEvidenceV37 =
  KnowledgeGroundingOperationEvidenceV36;

export type KnowledgeGroundingEvidenceV37 = Omit<
  KnowledgeGroundingEvidenceV36,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV37[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V37;
}>;

export type KnowledgeGroundingOperationEvidenceV38 =
  KnowledgeGroundingOperationEvidenceV37;

export type KnowledgeGroundingEvidenceV38 = Omit<
  KnowledgeGroundingEvidenceV37,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV38[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V38;
}>;

export type KnowledgeGroundingOperationEvidenceV39 =
  KnowledgeGroundingOperationEvidenceV38;

export type KnowledgeGroundingEvidenceV39 = Omit<
  KnowledgeGroundingEvidenceV38,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV39[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V39;
}>;

export type KnowledgeGroundingOperationEvidenceV40 =
  KnowledgeGroundingOperationEvidenceV39;

export type KnowledgeGroundingEvidenceV40 = Omit<
  KnowledgeGroundingEvidenceV39,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV40[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V40;
}>;

export type KnowledgeGroundingOperationEvidenceV41 =
  KnowledgeGroundingOperationEvidenceV40;

export type KnowledgeGroundingEvidenceV41 = Omit<
  KnowledgeGroundingEvidenceV40,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV41[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V41;
}>;

export type KnowledgeGroundingOperationEvidenceV42 =
  KnowledgeGroundingOperationEvidenceV41;

export type KnowledgeGroundingEvidenceV42 = Omit<
  KnowledgeGroundingEvidenceV41,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV42[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V42;
}>;

export type KnowledgeGroundingOperationEvidenceV43 =
  KnowledgeGroundingOperationEvidenceV42;

export type KnowledgeGroundingEvidenceV43 = Omit<
  KnowledgeGroundingEvidenceV42,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV43[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V43;
}>;

export type KnowledgeGroundingOperationEvidenceV44 =
  KnowledgeGroundingOperationEvidenceV43;

export type KnowledgeGroundingEvidenceV44 = Omit<
  KnowledgeGroundingEvidenceV43,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV44[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V44;
}>;

export type KnowledgeGroundingOperationEvidenceV45 =
  KnowledgeGroundingOperationEvidenceV44;

export type KnowledgeGroundingEvidenceV45 = Omit<
  KnowledgeGroundingEvidenceV44,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV45[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V45;
}>;

export type KnowledgeGroundingOperationEvidenceV46 =
  KnowledgeGroundingOperationEvidenceV45;

export type KnowledgeGroundingEvidenceV46 = Omit<
  KnowledgeGroundingEvidenceV45,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV46[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V46;
}>;

export type KnowledgeGroundingOperationEvidenceV47 =
  KnowledgeGroundingOperationEvidenceV46;

export type KnowledgeGroundingEvidenceV47 = Omit<
  KnowledgeGroundingEvidenceV46,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV47[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V47;
}>;

export type KnowledgeGroundingOperationEvidenceV48 =
  KnowledgeGroundingOperationEvidenceV47;

export type KnowledgeGroundingEvidenceV48 = Omit<
  KnowledgeGroundingEvidenceV47,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV48[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V48;
}>;

export type KnowledgeGroundingOperationEvidenceV49 =
  KnowledgeGroundingOperationEvidenceV48;

export type KnowledgeGroundingEvidenceV49 = Omit<
  KnowledgeGroundingEvidenceV48,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV49[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V49;
}>;

export type KnowledgeGroundingOperationEvidenceV50 =
  KnowledgeGroundingOperationEvidenceV49;

export type KnowledgeGroundingEvidenceV50 = Omit<
  KnowledgeGroundingEvidenceV49,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV50[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V50;
}>;

export type KnowledgeGroundingOperationEvidenceV51 =
  KnowledgeGroundingOperationEvidenceV50;

export type KnowledgeGroundingEvidenceV51 = Omit<
  KnowledgeGroundingEvidenceV50,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV51[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V51;
}>;

export type KnowledgeGroundingOperationEvidenceV52 = Omit<
  KnowledgeGroundingOperationEvidenceV51,
  "contractVersion" | "purpose"
> & Readonly<{
  contractVersion: 1 | 2 | 6 | 21;
  purpose: KnowledgeAnswerOperationScopeV6ClosureV2;
}>;

export type KnowledgeGroundingEvidenceV52 = Omit<
  KnowledgeGroundingEvidenceV51,
  "closure" | "operations" | "version"
> & Readonly<{
  closure: Readonly<{
    initialCoveredDimensionCount: number;
    initialExcludedDimensionCount: number;
    payloadHash: string;
    reopenedCoveredDimensionCount: number;
    reopenedDimensionCount: number;
    reopenedExcludedDimensionCount: number;
    status: "accepted";
  }> | null;
  operations: readonly KnowledgeGroundingOperationEvidenceV52[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V52;
}>;

export type KnowledgeGroundingOperationEvidenceV53 =
  KnowledgeGroundingOperationEvidenceV52;

export type KnowledgeGroundingEvidenceV53 = Omit<
  KnowledgeGroundingEvidenceV52,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV53[];
  version: typeof KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V53;
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
  | KnowledgeGroundingEvidenceV17
  | KnowledgeGroundingEvidenceV18
  | KnowledgeGroundingEvidenceV19
  | KnowledgeGroundingEvidenceV20
  | KnowledgeGroundingEvidenceV21
  | KnowledgeGroundingEvidenceV22
  | KnowledgeGroundingEvidenceV23
  | KnowledgeGroundingEvidenceV24
  | KnowledgeGroundingEvidenceV25
  | KnowledgeGroundingEvidenceV26
  | KnowledgeGroundingEvidenceV27
  | KnowledgeGroundingEvidenceV28
  | KnowledgeGroundingEvidenceV29
  | KnowledgeGroundingEvidenceV30
  | KnowledgeGroundingEvidenceV31
  | KnowledgeGroundingEvidenceV32
  | KnowledgeGroundingEvidenceV33
  | KnowledgeGroundingEvidenceV34
  | KnowledgeGroundingEvidenceV35
  | KnowledgeGroundingEvidenceV36
  | KnowledgeGroundingEvidenceV37
  | KnowledgeGroundingEvidenceV38
  | KnowledgeGroundingEvidenceV39
  | KnowledgeGroundingEvidenceV40
  | KnowledgeGroundingEvidenceV41
  | KnowledgeGroundingEvidenceV42
  | KnowledgeGroundingEvidenceV43
  | KnowledgeGroundingEvidenceV44
  | KnowledgeGroundingEvidenceV45
  | KnowledgeGroundingEvidenceV46
  | KnowledgeGroundingEvidenceV47
  | KnowledgeGroundingEvidenceV48
  | KnowledgeGroundingEvidenceV49
  | KnowledgeGroundingEvidenceV50
  | KnowledgeGroundingEvidenceV51
  | KnowledgeGroundingEvidenceV52
  | KnowledgeGroundingEvidenceV53;

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
      : role === "auditor" || role === "auditor_repair"
        ? KNOWLEDGE_COVERAGE_AUDITOR_OPERATION
        : role === "supplement"
          ? KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
          : KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17;
  const contractVersion = role === "primary" || role === "supplement"
    ? 21
    : role === "auditor" || role === "auditor_repair"
      ? 2
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
  contracts: KnowledgeAnswerV21AuditV2ContractVersions;
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
    ["primary", "initial", "auditor", "auditor_repair"],
    ["primary", "initial", "auditor", "supplement"],
    ["primary", "initial", "auditor", "supplement", "final"],
    ["primary", "initial", "auditor", "auditor_repair", "supplement"],
    ["primary", "initial", "auditor", "auditor_repair", "supplement", "final"],
    ["primary", "initial", "repair", "auditor"],
    ["primary", "initial", "repair", "auditor", "auditor_repair"],
    ["primary", "initial", "repair", "auditor", "supplement"],
    ["primary", "initial", "repair", "auditor", "supplement", "final"]
  ];
  const roles = input.operations.map(({ role }) => role);
  const validSequence = roleSequences.some((sequence) =>
    JSON.stringify(sequence) === JSON.stringify(roles));
  const operationsValid = validSequence && input.operations.every((operation, index) =>
    validGroundingOperationV17(operation, index + 1, roles[index]!));
  const auditor = input.operations.find(({ role }) => role === "auditor_repair") ??
    input.operations.find(({ role }) => role === "auditor");
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
    input.contracts.coverageAuditorContractVersion !== 2 ||
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

/** V18 adds the exact role policy and answer-binding fingerprint used by new
 * V21 operation snapshots. The V17 validator remains the single owner of the
 * audited protocol and settlement invariants. */
export function groundSettledKnowledgeAnswerV18(input: Parameters<
  typeof groundSettledKnowledgeAnswerV17
>[0] & Readonly<{
  answerBindingFingerprint: string;
  draftClaimCount: number;
  executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1;
  executionPolicyFingerprint: string;
}>): KnowledgeGroundingEvidenceV18 {
  const executionPolicy = decodeKnowledgeGroundingEffectiveExecutionPolicyV1(
    input.executionPolicy
  );
  if (!executionPolicy ||
    !/^[0-9a-f]{64}$/u.test(input.answerBindingFingerprint) ||
    !/^[0-9a-f]{64}$/u.test(input.executionPolicyFingerprint) ||
    input.executionPolicyFingerprint !== knowledgeAnswerHash(executionPolicy) ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || input.operations.some((operation) => {
      const usage = decodeKnowledgeProviderAttemptUsage(operation.usage);
      return !usage || usage.inputTokens === null || usage.outputTokens === null;
    })) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted Knowledge grounding policy evidence is invalid"
    );
  }
  const legacy = groundSettledKnowledgeAnswerV17(input);
  return Object.freeze({
    ...legacy,
    answerBindingFingerprint: input.answerBindingFingerprint,
    draftClaimCount: input.draftClaimCount,
    executionPolicy,
    executionPolicyFingerprint: input.executionPolicyFingerprint,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V18
  });
}

function validGroundingOperationV19(
  operation: KnowledgeGroundingOperationEvidenceV19,
  ordinal: number,
  role: KnowledgeGroundingOperationEvidenceV19["role"]
): boolean {
  const purpose = role === "primary"
    ? KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
    : role === "scope" || role === "scope_repair"
      ? KNOWLEDGE_COVERAGE_SCOPE_OPERATION
      : role === "initial" || role === "repair"
        ? KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V18
        : role === "supplement"
          ? KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
          : KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V18;
  const contractVersion = role === "primary" || role === "supplement"
    ? 21
    : role === "scope" || role === "scope_repair"
      ? 3
      : 18;
  return operation.ordinal === ordinal && operation.role === role &&
    operation.purpose === purpose && operation.contractVersion === contractVersion &&
    validOperationId(operation.operationId) && validDuration(operation.durationMs) &&
    /^[0-9a-f]{64}$/u.test(operation.acceptedRequestHash) &&
    /^[0-9a-f]{64}$/u.test(operation.acceptedResultHash) &&
    (operation.providerRequestId === null || operation.providerRequestId.length <= 1_024);
}

/** Content-free V19 provenance for the physically separated blind Scope
 * protocol. Private scope, Draft, verdicts, mappings, and answer text remain
 * outside the persisted receipt; hashes, counts, pins, and settlement
 * aggregates are sufficient for recovery and operations. */
export function groundSettledKnowledgeAnswerV19(input: Readonly<{
  answerBindingFingerprint: string;
  contracts: KnowledgeAnswerV21ScopeV3ContractVersions;
  coverage: Readonly<{
    coveredDimensionCount: number;
    missingDimensionCount: number;
    selectorPayloadHash: string;
  }>;
  coverageScope: Readonly<{
    dimensionCount: number;
    payloadHash: string;
  }>;
  draftClaimCount: number;
  evidence: KnowledgeEvidencePackage;
  evidenceReceiptHash: string;
  executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1;
  executionPolicyFingerprint: string;
  modelPinFingerprint: string;
  operations: readonly KnowledgeGroundingOperationEvidenceV19[];
  providerPinFingerprint: string;
  scopeRepairSucceeded: boolean;
  selectorRepairSucceeded: boolean;
  settlement: KnowledgeAnswerSettlementV5;
}>): KnowledgeGroundingEvidenceV19 {
  const roleSequences: KnowledgeGroundingOperationEvidenceV19["role"][][] = [];
  for (const scopeRepair of [false, true]) {
    for (const selectorRepair of [false, true]) {
      const base: KnowledgeGroundingOperationEvidenceV19["role"][] = [
        "primary",
        "scope",
        ...(scopeRepair ? ["scope_repair" as const] : []),
        "initial",
        ...(selectorRepair ? ["repair" as const] : [])
      ];
      roleSequences.push(base);
      if (base.length + 2 <= 6) {
        roleSequences.push([...base, "supplement"], [...base, "supplement", "final"]);
      }
    }
  }
  const roles = input.operations.map(({ role }) => role);
  const validSequence = roleSequences.some((sequence) =>
    JSON.stringify(sequence) === JSON.stringify(roles));
  const operationsValid = validSequence && input.operations.every((operation, index) =>
    validGroundingOperationV19(operation, index + 1, roles[index]!));
  const scope = input.operations.find(({ role }) => role === "scope_repair") ??
    input.operations.find(({ role }) => role === "scope");
  const initialSelector = input.operations.find(({ role }) => role === "repair") ??
    input.operations.find(({ role }) => role === "initial");
  const correctionAttempted = roles.includes("supplement");
  const correctionSucceeded = roles.includes("final");
  const scopeRepairAttempted = roles.includes("scope_repair");
  const selectorRepairAttempted = roles.includes("repair");
  const supportedContentCount = input.settlement.supportedClaimCount +
    (input.settlement.finalizationMode === "evidence_only" ||
      input.settlement.finalizationMode === "selected_claims_with_evidence" ? 1 : 0);
  const initialCoverage = supportedContentCount === 0 ||
    input.coverage.coveredDimensionCount === 0
    ? "none"
    : input.coverage.missingDimensionCount === 0
      ? "complete"
      : "partial";
  const settlementCoverageValid = correctionSucceeded
    ? supportedContentCount === 0
      ? input.settlement.requestCoverage === "none"
      : input.settlement.requestCoverage === "partial" ||
        input.settlement.requestCoverage === "complete"
    : input.settlement.requestCoverage === initialCoverage;
  const executionPolicy = decodeKnowledgeGroundingEffectiveExecutionPolicyV1(
    input.executionPolicy
  );
  if (input.contracts.draftContractVersion !== 21 ||
    input.contracts.selectorContractVersion !== 18 ||
    input.contracts.coverageAuditorContractVersion !== 3 ||
    input.contracts.settlementVersion !== 6 || !operationsValid || !scope ||
    !initialSelector || input.coverageScope.payloadHash !== scope.acceptedResultHash ||
    input.coverage.selectorPayloadHash !== initialSelector.acceptedResultHash ||
    !Number.isSafeInteger(input.coverageScope.dimensionCount) ||
    input.coverageScope.dimensionCount < 1 || input.coverageScope.dimensionCount > 8 ||
    !Number.isSafeInteger(input.coverage.coveredDimensionCount) ||
    input.coverage.coveredDimensionCount < 0 ||
    !Number.isSafeInteger(input.coverage.missingDimensionCount) ||
    input.coverage.missingDimensionCount < 0 ||
    input.coverage.coveredDimensionCount + input.coverage.missingDimensionCount !==
      input.coverageScope.dimensionCount ||
    input.scopeRepairSucceeded !== scopeRepairAttempted ||
    input.selectorRepairSucceeded !== selectorRepairAttempted ||
    correctionSucceeded && !correctionAttempted ||
    correctionAttempted && input.coverage.missingDimensionCount === 0 ||
    !settlementCoverageValid || !executionPolicy ||
    !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash) ||
    !/^[0-9a-f]{64}$/u.test(input.modelPinFingerprint) ||
    !/^[0-9a-f]{64}$/u.test(input.providerPinFingerprint) ||
    !/^[0-9a-f]{64}$/u.test(input.answerBindingFingerprint) ||
    !/^[0-9a-f]{64}$/u.test(input.executionPolicyFingerprint) ||
    input.executionPolicyFingerprint !== knowledgeAnswerHash(executionPolicy) ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || input.operations.some((operation) => {
      const usage = decodeKnowledgeProviderAttemptUsage(operation.usage);
      return !usage || usage.inputTokens === null || usage.outputTokens === null;
    })) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted blind-scope Knowledge grounding evidence is invalid"
    );
  }
  const operations = Object.freeze(input.operations.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  return Object.freeze({
    answerBindingFingerprint: input.answerBindingFingerprint,
    contracts: Object.freeze({ ...input.contracts }),
    correctionAttempted,
    correctionSucceeded,
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    coverage: Object.freeze({ ...input.coverage, status: "accepted" as const }),
    coverageScope: Object.freeze({
      ...input.coverageScope,
      status: "accepted" as const
    }),
    draftClaimCount: input.draftClaimCount,
    evidenceReceiptHash: input.evidenceReceiptHash,
    executionPolicy,
    executionPolicyFingerprint: input.executionPolicyFingerprint,
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
    scopeRepairAttempted,
    scopeRepairSucceeded: input.scopeRepairSucceeded,
    selectorRepairAttempted,
    selectorRepairSucceeded: input.selectorRepairSucceeded,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V19
  });
}

function validGroundingOperationV20(
  operation: KnowledgeGroundingOperationEvidenceV20,
  ordinal: number
): boolean {
  const purpose = operation.role === "primary"
    ? KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
    : operation.role === "scope" || operation.role === "scope_repair"
      ? KNOWLEDGE_COVERAGE_SCOPE_V4_OPERATION
      : operation.role === "initial" || operation.role === "repair"
        ? KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V19
        : operation.role === "supplement"
          ? KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
          : KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V19;
  const contractVersion = operation.role === "primary" ||
    operation.role === "supplement"
    ? 21
    : operation.role === "scope" || operation.role === "scope_repair"
      ? 4
      : 19;
  return operation.ordinal === ordinal && operation.purpose === purpose &&
    operation.contractVersion === contractVersion;
}

/** V20 retains the content-free V19 receipt while attesting the exhaustive
 * evidence-atom review contract and its V19 Selector consumer. */
export function groundSettledKnowledgeAnswerV20(input: Omit<Parameters<
  typeof groundSettledKnowledgeAnswerV19
>[0], "contracts" | "operations"> & Readonly<{
  contracts: KnowledgeAnswerV21ScopeV4ContractVersions;
  operations: readonly KnowledgeGroundingOperationEvidenceV20[];
}>): KnowledgeGroundingEvidenceV20 {
  if (input.contracts.draftContractVersion !== 21 ||
    input.contracts.selectorContractVersion !== 19 ||
    input.contracts.coverageAuditorContractVersion !== 4 ||
    input.contracts.settlementVersion !== 6 ||
    !input.operations.every((operation, index) =>
      validGroundingOperationV20(operation, index + 1))) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted atom-review Knowledge grounding evidence is invalid"
    );
  }
  const historicalOperations: KnowledgeGroundingOperationEvidenceV19[] =
    input.operations.map((operation) => {
      const scope = operation.role === "scope" || operation.role === "scope_repair";
      const selector = operation.role === "initial" || operation.role === "repair" ||
        operation.role === "final";
      return Object.freeze({
        ...operation,
        contractVersion: scope ? 3 as const : selector ? 18 as const : 21 as const,
        purpose: scope
          ? KNOWLEDGE_COVERAGE_SCOPE_OPERATION
          : operation.role === "initial" || operation.role === "repair"
            ? KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V18
            : operation.role === "final"
              ? KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V18
              : operation.purpose
      }) as KnowledgeGroundingOperationEvidenceV19;
    });
  const historical = groundSettledKnowledgeAnswerV19({
    ...input,
    contracts: Object.freeze({
      coverageAuditorContractVersion: 3,
      draftContractVersion: 21,
      selectorContractVersion: 18,
      settlementVersion: 6
    }),
    operations: Object.freeze(historicalOperations)
  });
  return Object.freeze({
    ...historical,
    contracts: Object.freeze({ ...input.contracts }),
    operations: Object.freeze(input.operations.map((operation) => Object.freeze({
      ...operation,
      usage: Object.freeze({ ...operation.usage })
    }))),
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V20
  });
}

function validGroundingOperationV21(
  operation: KnowledgeGroundingOperationEvidenceV21,
  ordinal: number
): boolean {
  const purpose = operation.role === "primary"
    ? KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
    : operation.role === "scope" || operation.role === "scope_repair"
      ? KNOWLEDGE_COVERAGE_SCOPE_V5_OPERATION
      : operation.role === "initial" || operation.role === "repair"
        ? KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V20
        : operation.role === "supplement"
          ? KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
          : KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V20;
  const contractVersion = operation.role === "primary" ||
    operation.role === "supplement"
    ? 21
    : operation.role === "scope" || operation.role === "scope_repair"
      ? 5
      : 20;
  return operation.ordinal === ordinal && operation.purpose === purpose &&
    operation.contractVersion === contractVersion;
}

/** V21 retains the content-free V20 receipt while attesting sparse positive
 * evidence-unit maps, deterministic complement/provenance, and Selector V20. */
export function groundSettledKnowledgeAnswerV21(input: Omit<Parameters<
  typeof groundSettledKnowledgeAnswerV20
>[0], "contracts" | "operations"> & Readonly<{
  contracts: KnowledgeAnswerV21ScopeV5ContractVersions;
  operations: readonly KnowledgeGroundingOperationEvidenceV21[];
}>): KnowledgeGroundingEvidenceV21 {
  if (input.contracts.draftContractVersion !== 21 ||
    input.contracts.selectorContractVersion !== 20 ||
    input.contracts.coverageAuditorContractVersion !== 5 ||
    input.contracts.settlementVersion !== 6 ||
    !input.operations.every((operation, index) =>
      validGroundingOperationV21(operation, index + 1))) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted sparse-unit-map Knowledge grounding evidence is invalid"
    );
  }
  const historicalOperations: KnowledgeGroundingOperationEvidenceV20[] =
    input.operations.map((operation) => {
      const scope = operation.role === "scope" || operation.role === "scope_repair";
      const selector = operation.role === "initial" || operation.role === "repair" ||
        operation.role === "final";
      return Object.freeze({
        ...operation,
        contractVersion: scope ? 4 as const : selector ? 19 as const : 21 as const,
        purpose: scope
          ? KNOWLEDGE_COVERAGE_SCOPE_V4_OPERATION
          : operation.role === "initial" || operation.role === "repair"
            ? KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V19
            : operation.role === "final"
              ? KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V19
              : operation.purpose
      }) as KnowledgeGroundingOperationEvidenceV20;
    });
  const historical = groundSettledKnowledgeAnswerV20({
    ...input,
    contracts: Object.freeze({
      coverageAuditorContractVersion: 4,
      draftContractVersion: 21,
      selectorContractVersion: 19,
      settlementVersion: 6
    }),
    operations: Object.freeze(historicalOperations)
  });
  return Object.freeze({
    ...historical,
    contracts: Object.freeze({ ...input.contracts }),
    operations: Object.freeze(input.operations.map((operation) => Object.freeze({
      ...operation,
      usage: Object.freeze({ ...operation.usage })
    }))),
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V21
  });
}

function validGroundingOperationV22(
  operation: KnowledgeGroundingOperationEvidenceV22,
  ordinal: number
): boolean {
  const purpose = operation.role === "primary"
    ? KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
    : operation.role === "scope" || operation.role === "scope_repair"
      ? KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
      : operation.role === "initial" || operation.role === "repair"
        ? KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
        : operation.role === "supplement"
          ? KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
          : KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21;
  const contractVersion = operation.role === "primary" ||
    operation.role === "supplement" || operation.role === "initial" ||
    operation.role === "repair" || operation.role === "final"
    ? 21
    : 6;
  return operation.ordinal === ordinal && operation.purpose === purpose &&
    operation.contractVersion === contractVersion;
}

/** V22 retains the content-free V21 receipt while attesting lossless positive
 * finding materialization, exact atom provenance, and Selector V21. */
export function groundSettledKnowledgeAnswerV22(input: Omit<Parameters<
  typeof groundSettledKnowledgeAnswerV21
>[0], "contracts" | "operations"> & Readonly<{
  contracts: KnowledgeAnswerV21ContractVersions;
  operations: readonly KnowledgeGroundingOperationEvidenceV22[];
}>): KnowledgeGroundingEvidenceV22 {
  if (input.contracts.draftContractVersion !== 21 ||
    input.contracts.selectorContractVersion !== 21 ||
    input.contracts.coverageAuditorContractVersion !== 6 ||
    input.contracts.settlementVersion !== 6 ||
    !input.operations.every((operation, index) =>
      validGroundingOperationV22(operation, index + 1))) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted positive-finding Knowledge grounding evidence is invalid"
    );
  }
  const historicalOperations: KnowledgeGroundingOperationEvidenceV21[] =
    input.operations.map((operation) => {
      const scope = operation.role === "scope" || operation.role === "scope_repair";
      const selector = operation.role === "initial" || operation.role === "repair" ||
        operation.role === "final";
      return Object.freeze({
        ...operation,
        contractVersion: scope ? 5 as const : selector ? 20 as const : 21 as const,
        purpose: scope
          ? KNOWLEDGE_COVERAGE_SCOPE_V5_OPERATION
          : operation.role === "initial" || operation.role === "repair"
            ? KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V20
            : operation.role === "final"
              ? KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V20
              : operation.purpose
      }) as KnowledgeGroundingOperationEvidenceV21;
    });
  const historical = groundSettledKnowledgeAnswerV21({
    ...input,
    contracts: Object.freeze({
      coverageAuditorContractVersion: 5,
      draftContractVersion: 21,
      selectorContractVersion: 20,
      settlementVersion: 6
    }),
    operations: Object.freeze(historicalOperations)
  });
  return Object.freeze({
    ...historical,
    contracts: Object.freeze({ ...input.contracts }),
    operations: Object.freeze(input.operations.map((operation) => Object.freeze({
      ...operation,
      usage: Object.freeze({ ...operation.usage })
    }))),
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V22
  });
}

type KnowledgeGroundingV23Input = Omit<
  Parameters<typeof groundSettledKnowledgeAnswerV22>[0],
  "coverage"
> & Readonly<{
  coverage: Readonly<{
    coveredDimensionCount: number;
    excludedDimensionCount: number;
    missingDimensionCount: number;
    selectorPayloadHash: string;
  }>;
}>;

/** V23 is the content-free attestation for Snapshot V7's target-addressed,
 * monotonic correction delta and Selector-owned Scope eligibility. V22 remains
 * the exact historical Scope V6 full-recomputation receipt and is never
 * reinterpreted. */
export function groundSettledKnowledgeAnswerV23(
  input: KnowledgeGroundingV23Input
): KnowledgeGroundingEvidenceV23 {
  const excludedDimensionCount = input.coverage.excludedDimensionCount;
  const eligibleDimensionCount = input.coverage.coveredDimensionCount +
    input.coverage.missingDimensionCount;
  if (!Number.isSafeInteger(excludedDimensionCount) || excludedDimensionCount < 0 ||
    eligibleDimensionCount + excludedDimensionCount !==
      input.coverageScope.dimensionCount) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted eligibility-aware Knowledge grounding evidence is invalid"
    );
  }
  // V22 validates every shared operation, pin, hash, usage, and settlement
  // invariant. Its historical two-state coverage view receives only eligible
  // dimensions. The all-excluded case uses one synthetic missing slot solely
  // for that private validator; the returned V23 projection is always exact.
  const historical = groundSettledKnowledgeAnswerV22({
    ...input,
    coverage: Object.freeze({
      coveredDimensionCount: input.coverage.coveredDimensionCount,
      missingDimensionCount: eligibleDimensionCount === 0
        ? 1
        : input.coverage.missingDimensionCount,
      selectorPayloadHash: input.coverage.selectorPayloadHash
    }),
    coverageScope: Object.freeze({
      ...input.coverageScope,
      dimensionCount: eligibleDimensionCount === 0 ? 1 : eligibleDimensionCount
    })
  });
  return Object.freeze({
    ...historical,
    coverage: Object.freeze({ ...input.coverage, status: "accepted" as const }),
    coverageScope: Object.freeze({
      ...input.coverageScope,
      status: "accepted" as const
    }),
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V23
  });
}

type KnowledgeGroundingV24Input = Omit<
  KnowledgeGroundingV23Input,
  "operations"
> & Readonly<{
  completeness: Readonly<{
    addedDimensionCount: number;
    initialDimensionCount: number;
    initialScopePayloadHash: string;
    payloadHash: string;
  }>;
  completenessRepairSucceeded: boolean;
  operations: readonly KnowledgeGroundingOperationEvidenceV24[];
}>;

function validGroundingOperationV24(
  operation: KnowledgeGroundingOperationEvidenceV24 |
    KnowledgeGroundingOperationEvidenceV25 |
    KnowledgeGroundingOperationEvidenceRepairBudgetV2,
  ordinal: number
): boolean {
  const purpose = operation.role === "primary"
    ? KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
    : operation.role === "scope" || operation.role === "scope_repair"
      ? KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
      : operation.role === "scope_completeness" ||
          operation.role === "scope_completeness_repair"
        ? KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
        : operation.role === "initial" || operation.role === "repair"
          ? KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
          : operation.role === "supplement"
            ? KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
            : KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21;
  const contractVersion = operation.role === "scope" || operation.role === "scope_repair"
    ? 6
    : operation.role === "scope_completeness" ||
        operation.role === "scope_completeness_repair"
      ? 1
      : 21;
  return operation.ordinal === ordinal && operation.purpose === purpose &&
    operation.contractVersion === contractVersion &&
    validOperationId(operation.operationId) && validDuration(operation.durationMs) &&
    /^[0-9a-f]{64}$/u.test(operation.acceptedRequestHash) &&
    /^[0-9a-f]{64}$/u.test(operation.acceptedResultHash) &&
    (operation.providerRequestId === null || operation.providerRequestId.length <= 1_024);
}

/** V24 attests Snapshot V8's physically separate append-only Scope
 * completeness pass. The receipt remains content-free: it stores only hashes,
 * counts, roles, timings, usage, pins, and settlement aggregates. */
export function groundSettledKnowledgeAnswerV24(
  input: KnowledgeGroundingV24Input
): KnowledgeGroundingEvidenceV24 {
  const roleSequences: KnowledgeGroundingOperationEvidenceV24["role"][][] = [];
  for (const scopeRepair of [false, true]) {
    for (const completenessRepair of [false, true]) {
      for (const selectorRepair of [false, true]) {
        const base: KnowledgeGroundingOperationEvidenceV24["role"][] = [
          "primary",
          "scope",
          ...(scopeRepair ? ["scope_repair" as const] : []),
          "scope_completeness",
          ...(completenessRepair ? ["scope_completeness_repair" as const] : []),
          "initial",
          ...(selectorRepair ? ["repair" as const] : [])
        ];
        if (base.length <= 6) roleSequences.push(base);
        if (base.length + 2 <= 6) {
          roleSequences.push([...base, "supplement"], [...base, "supplement", "final"]);
        }
      }
    }
  }
  const roles = input.operations.map(({ role }) => role);
  const validSequence = roleSequences.some((sequence) =>
    JSON.stringify(sequence) === JSON.stringify(roles));
  const operationsValid = validSequence && input.operations.every((operation, index) =>
    validGroundingOperationV24(operation, index + 1));
  const scope = input.operations.find(({ role }) => role === "scope_repair") ??
    input.operations.find(({ role }) => role === "scope");
  const completeness = input.operations.find(
    ({ role }) => role === "scope_completeness_repair"
  ) ?? input.operations.find(({ role }) => role === "scope_completeness");
  const initialSelector = input.operations.find(({ role }) => role === "repair") ??
    input.operations.find(({ role }) => role === "initial");
  const scopeRepairAttempted = roles.includes("scope_repair");
  const completenessRepairAttempted = roles.includes("scope_completeness_repair");
  const selectorRepairAttempted = roles.includes("repair");
  const correctionAttempted = roles.includes("supplement");
  const correctionSucceeded = roles.includes("final");
  const eligibleDimensionCount = input.coverage.coveredDimensionCount +
    input.coverage.missingDimensionCount;
  const supportedContentCount = input.settlement.supportedClaimCount +
    (input.settlement.finalizationMode === "evidence_only" ||
      input.settlement.finalizationMode === "selected_claims_with_evidence" ? 1 : 0);
  const initialCoverage = supportedContentCount === 0 ||
    input.coverage.coveredDimensionCount === 0
    ? "none"
    : input.coverage.missingDimensionCount === 0
      ? "complete"
      : "partial";
  const settlementCoverageValid = correctionSucceeded
    ? supportedContentCount === 0
      ? input.settlement.requestCoverage === "none"
      : input.settlement.requestCoverage === "partial" ||
        input.settlement.requestCoverage === "complete"
    : input.settlement.requestCoverage === initialCoverage;
  const executionPolicy = decodeKnowledgeGroundingEffectiveExecutionPolicyV1(
    input.executionPolicy
  );
  if (input.contracts.draftContractVersion !== 21 ||
    input.contracts.selectorContractVersion !== 21 ||
    input.contracts.coverageAuditorContractVersion !== 6 ||
    input.contracts.settlementVersion !== 6 || !operationsValid || !scope ||
    !completeness || !initialSelector ||
    input.completeness.payloadHash !== completeness.acceptedResultHash ||
    input.coverage.selectorPayloadHash !== initialSelector.acceptedResultHash ||
    !Number.isSafeInteger(input.completeness.initialDimensionCount) ||
    input.completeness.initialDimensionCount < 1 ||
    input.completeness.initialDimensionCount > 8 ||
    !Number.isSafeInteger(input.completeness.addedDimensionCount) ||
    input.completeness.addedDimensionCount < 0 ||
    input.completeness.initialDimensionCount +
      input.completeness.addedDimensionCount !== input.coverageScope.dimensionCount ||
    !/^[0-9a-f]{64}$/u.test(input.completeness.initialScopePayloadHash) ||
    !/^[0-9a-f]{64}$/u.test(input.completeness.payloadHash) ||
    !Number.isSafeInteger(input.coverageScope.dimensionCount) ||
    input.coverageScope.dimensionCount < 1 || input.coverageScope.dimensionCount > 8 ||
    !/^[0-9a-f]{64}$/u.test(input.coverageScope.payloadHash) ||
    !Number.isSafeInteger(input.coverage.coveredDimensionCount) ||
    input.coverage.coveredDimensionCount < 0 ||
    !Number.isSafeInteger(input.coverage.missingDimensionCount) ||
    input.coverage.missingDimensionCount < 0 ||
    !Number.isSafeInteger(input.coverage.excludedDimensionCount) ||
    input.coverage.excludedDimensionCount < 0 ||
    eligibleDimensionCount + input.coverage.excludedDimensionCount !==
      input.coverageScope.dimensionCount ||
    !/^[0-9a-f]{64}$/u.test(input.coverage.selectorPayloadHash) ||
    input.scopeRepairSucceeded !== scopeRepairAttempted ||
    input.completenessRepairSucceeded !== completenessRepairAttempted ||
    input.selectorRepairSucceeded !== selectorRepairAttempted ||
    correctionSucceeded && !correctionAttempted ||
    correctionAttempted && input.coverage.missingDimensionCount === 0 ||
    !settlementCoverageValid || !executionPolicy ||
    !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash) ||
    !/^[0-9a-f]{64}$/u.test(input.modelPinFingerprint) ||
    !/^[0-9a-f]{64}$/u.test(input.providerPinFingerprint) ||
    !/^[0-9a-f]{64}$/u.test(input.answerBindingFingerprint) ||
    !/^[0-9a-f]{64}$/u.test(input.executionPolicyFingerprint) ||
    input.executionPolicyFingerprint !== knowledgeAnswerHash(executionPolicy) ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || input.operations.some((operation) => {
      const usage = decodeKnowledgeProviderAttemptUsage(operation.usage);
      return !usage || usage.inputTokens === null || usage.outputTokens === null;
    })) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted append-only Scope-completeness grounding evidence is invalid"
    );
  }
  const operations = Object.freeze(input.operations.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  return Object.freeze({
    answerBindingFingerprint: input.answerBindingFingerprint,
    completeness: Object.freeze({ ...input.completeness, status: "accepted" as const }),
    completenessRepairAttempted,
    completenessRepairSucceeded: input.completenessRepairSucceeded,
    contracts: Object.freeze({ ...input.contracts }),
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    correctionAttempted,
    correctionSucceeded,
    coverage: Object.freeze({ ...input.coverage, status: "accepted" as const }),
    coverageScope: Object.freeze({
      ...input.coverageScope,
      status: "accepted" as const
    }),
    draftClaimCount: input.draftClaimCount,
    evidenceReceiptHash: input.evidenceReceiptHash,
    executionPolicy,
    executionPolicyFingerprint: input.executionPolicyFingerprint,
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
    scopeRepairAttempted,
    scopeRepairSucceeded: input.scopeRepairSucceeded,
    selectorRepairAttempted,
    selectorRepairSucceeded: input.selectorRepairSucceeded,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V24
  });
}

type KnowledgeGroundingV25Input = Omit<
  KnowledgeGroundingV24Input,
  "operations"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV25[];
}>;

type KnowledgeGroundingRepairBudgetInput = Omit<
  KnowledgeGroundingV25Input,
  "operations"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceRepairBudgetV2[];
}>;

type KnowledgeGroundingRepairBudgetEvidence = Omit<
  KnowledgeGroundingEvidenceV25,
  "operations" | "version"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceRepairBudgetV2[];
}>;

function groundSettledKnowledgeAnswerRepairBudget(
  input: KnowledgeGroundingRepairBudgetInput,
  maxOperationCount: number
): KnowledgeGroundingRepairBudgetEvidence {
  const roleSequences: KnowledgeGroundingOperationEvidenceRepairBudgetV2["role"][][] = [];
  for (const scopeRepair of [false, true]) {
    for (const completenessRepair of [false, true]) {
      for (const selectorRepair of [false, true]) {
        const base: KnowledgeGroundingOperationEvidenceRepairBudgetV2["role"][] = [
          "primary",
          "scope",
          ...(scopeRepair ? ["scope_repair" as const] : []),
          "scope_completeness",
          ...(completenessRepair ? ["scope_completeness_repair" as const] : []),
          "initial",
          ...(selectorRepair ? ["repair" as const] : [])
        ];
        if (base.length <= maxOperationCount) roleSequences.push(base);
        if (base.length + 2 <= maxOperationCount) {
          roleSequences.push([...base, "supplement"], [...base, "supplement", "final"]);
        }
      }
    }
  }
  const roles = input.operations.map(({ role }) => role);
  const validSequence = roleSequences.some((sequence) =>
    JSON.stringify(sequence) === JSON.stringify(roles));
  const operationsValid = validSequence && input.operations.every((operation, index) =>
    validGroundingOperationV24(operation, index + 1));
  const scope = input.operations.find(({ role }) => role === "scope_repair") ??
    input.operations.find(({ role }) => role === "scope");
  const completeness = input.operations.find(
    ({ role }) => role === "scope_completeness_repair"
  ) ?? input.operations.find(({ role }) => role === "scope_completeness");
  const initialSelector = input.operations.find(({ role }) => role === "repair") ??
    input.operations.find(({ role }) => role === "initial");
  const scopeRepairAttempted = roles.includes("scope_repair");
  const completenessRepairAttempted = roles.includes("scope_completeness_repair");
  const selectorRepairAttempted = roles.includes("repair");
  const correctionAttempted = roles.includes("supplement");
  const correctionSucceeded = roles.includes("final");
  const eligibleDimensionCount = input.coverage.coveredDimensionCount +
    input.coverage.missingDimensionCount;
  const supportedContentCount = input.settlement.supportedClaimCount +
    (input.settlement.finalizationMode === "evidence_only" ||
      input.settlement.finalizationMode === "selected_claims_with_evidence" ? 1 : 0);
  const initialCoverage = supportedContentCount === 0 ||
    input.coverage.coveredDimensionCount === 0
    ? "none"
    : input.coverage.missingDimensionCount === 0
      ? "complete"
      : "partial";
  const settlementCoverageValid = correctionSucceeded
    ? supportedContentCount === 0
      ? input.settlement.requestCoverage === "none"
      : input.settlement.requestCoverage === "partial" ||
        input.settlement.requestCoverage === "complete"
    : input.settlement.requestCoverage === initialCoverage;
  const executionPolicy = decodeKnowledgeGroundingEffectiveExecutionPolicyV1(
    input.executionPolicy
  );
  if (maxOperationCount !== KNOWLEDGE_ANSWER_SCOPE_V6_CLOSURE_MAX_OPERATION_COUNT_V1 &&
    maxOperationCount !==
      KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2 ||
    input.contracts.draftContractVersion !== 21 ||
    input.contracts.selectorContractVersion !== 21 ||
    input.contracts.coverageAuditorContractVersion !== 6 ||
    input.contracts.settlementVersion !== 6 || !operationsValid || !scope ||
    !completeness || !initialSelector ||
    input.completeness.payloadHash !== completeness.acceptedResultHash ||
    input.coverage.selectorPayloadHash !== initialSelector.acceptedResultHash ||
    !Number.isSafeInteger(input.completeness.initialDimensionCount) ||
    input.completeness.initialDimensionCount < 1 ||
    input.completeness.initialDimensionCount > 8 ||
    !Number.isSafeInteger(input.completeness.addedDimensionCount) ||
    input.completeness.addedDimensionCount < 0 ||
    input.completeness.initialDimensionCount +
      input.completeness.addedDimensionCount !== input.coverageScope.dimensionCount ||
    !/^[0-9a-f]{64}$/u.test(input.completeness.initialScopePayloadHash) ||
    !/^[0-9a-f]{64}$/u.test(input.completeness.payloadHash) ||
    !Number.isSafeInteger(input.coverageScope.dimensionCount) ||
    input.coverageScope.dimensionCount < 1 || input.coverageScope.dimensionCount > 8 ||
    !/^[0-9a-f]{64}$/u.test(input.coverageScope.payloadHash) ||
    !Number.isSafeInteger(input.coverage.coveredDimensionCount) ||
    input.coverage.coveredDimensionCount < 0 ||
    !Number.isSafeInteger(input.coverage.missingDimensionCount) ||
    input.coverage.missingDimensionCount < 0 ||
    !Number.isSafeInteger(input.coverage.excludedDimensionCount) ||
    input.coverage.excludedDimensionCount < 0 ||
    eligibleDimensionCount + input.coverage.excludedDimensionCount !==
      input.coverageScope.dimensionCount ||
    !/^[0-9a-f]{64}$/u.test(input.coverage.selectorPayloadHash) ||
    input.scopeRepairSucceeded !== scopeRepairAttempted ||
    input.completenessRepairSucceeded !== completenessRepairAttempted ||
    input.selectorRepairSucceeded !== selectorRepairAttempted ||
    correctionSucceeded && !correctionAttempted ||
    correctionAttempted && input.coverage.missingDimensionCount === 0 ||
    !settlementCoverageValid || !executionPolicy ||
    !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash) ||
    !/^[0-9a-f]{64}$/u.test(input.modelPinFingerprint) ||
    !/^[0-9a-f]{64}$/u.test(input.providerPinFingerprint) ||
    !/^[0-9a-f]{64}$/u.test(input.answerBindingFingerprint) ||
    !/^[0-9a-f]{64}$/u.test(input.executionPolicyFingerprint) ||
    input.executionPolicyFingerprint !== knowledgeAnswerHash(executionPolicy) ||
    !Number.isSafeInteger(input.draftClaimCount) || input.draftClaimCount < 0 ||
    input.draftClaimCount > 24 || input.operations.some((operation) => {
      const usage = decodeKnowledgeProviderAttemptUsage(operation.usage);
      return !usage || usage.inputTokens === null || usage.outputTokens === null;
    })) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted repair-budgeted Scope-completeness grounding evidence is invalid"
    );
  }
  const operations = Object.freeze(input.operations.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  return Object.freeze({
    answerBindingFingerprint: input.answerBindingFingerprint,
    completeness: Object.freeze({ ...input.completeness, status: "accepted" as const }),
    completenessRepairAttempted,
    completenessRepairSucceeded: input.completenessRepairSucceeded,
    contracts: Object.freeze({ ...input.contracts }),
    contradictedClaimCount: input.settlement.contradictedClaimCount,
    correctionAttempted,
    correctionSucceeded,
    coverage: Object.freeze({ ...input.coverage, status: "accepted" as const }),
    coverageScope: Object.freeze({
      ...input.coverageScope,
      status: "accepted" as const
    }),
    draftClaimCount: input.draftClaimCount,
    evidenceReceiptHash: input.evidenceReceiptHash,
    executionPolicy,
    executionPolicyFingerprint: input.executionPolicyFingerprint,
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
    scopeRepairAttempted,
    scopeRepairSucceeded: input.scopeRepairSucceeded,
    selectorRepairAttempted,
    selectorRepairSucceeded: input.selectorRepairSucceeded,
    sessionId: input.evidence.sessionId,
    supportedClaimCount: input.settlement.supportedClaimCount,
    unsupportedClaimCount: input.settlement.unsupportedClaimCount
  });
}

/** V25 attests Snapshot V9's repair-reserved execution budget. It preserves
 * V24's content-free append-only completeness contract while allowing one
 * validation repair followed by the bounded Supplement/final-Selector pair. */
export function groundSettledKnowledgeAnswerV25(
  input: KnowledgeGroundingV25Input
): KnowledgeGroundingEvidenceV25 {
  const grounded = groundSettledKnowledgeAnswerRepairBudget(
    input,
    KNOWLEDGE_ANSWER_SCOPE_V6_CLOSURE_MAX_OPERATION_COUNT_V1
  );
  return Object.freeze({
    ...grounded,
    operations: grounded.operations as readonly KnowledgeGroundingOperationEvidenceV25[],
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V25
  });
}

/** V26 distinguishes Snapshot V10's deterministic claim-surface recovery from
 * V25. The content-free operation and seven-call budget invariants are
 * otherwise byte-for-byte identical. */
export function groundSettledKnowledgeAnswerV26(
  input: KnowledgeGroundingV25Input
): KnowledgeGroundingEvidenceV26 {
  const grounded = groundSettledKnowledgeAnswerV25(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V26
  });
}

/** V27 distinguishes Snapshot V11's exact target-group handoff from V26. The
 * content-free operation and seven-call budget invariants remain identical. */
export function groundSettledKnowledgeAnswerV27(
  input: KnowledgeGroundingV25Input
): KnowledgeGroundingEvidenceV27 {
  const grounded = groundSettledKnowledgeAnswerV26(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V27
  });
}

/** V28 distinguishes Snapshot V12's delimiter-aware plain-claim validation
 * from V27. Receipt content and seven-call invariants remain unchanged. */
export function groundSettledKnowledgeAnswerV28(
  input: KnowledgeGroundingV25Input
): KnowledgeGroundingEvidenceV28 {
  const grounded = groundSettledKnowledgeAnswerV27(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V28
  });
}

/** V29 distinguishes Snapshot V13's deterministic Selector support-edge
 * canonicalization from V28. Receipt content and seven-call invariants remain
 * unchanged. */
export function groundSettledKnowledgeAnswerV29(
  input: KnowledgeGroundingV25Input
): KnowledgeGroundingEvidenceV29 {
  const grounded = groundSettledKnowledgeAnswerV28(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V29
  });
}

/** V30 distinguishes Snapshot V14's collective target-support mapping from
 * V29. Receipt content and seven-call invariants remain unchanged. */
export function groundSettledKnowledgeAnswerV30(
  input: KnowledgeGroundingV25Input
): KnowledgeGroundingEvidenceV30 {
  const grounded = groundSettledKnowledgeAnswerV29(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V30
  });
}

/** V31 distinguishes Snapshot V15's content-safe Scope validation feedback
 * from V30. Receipt content and seven-call invariants remain unchanged. */
export function groundSettledKnowledgeAnswerV31(
  input: KnowledgeGroundingV25Input
): KnowledgeGroundingEvidenceV31 {
  const grounded = groundSettledKnowledgeAnswerV30(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V31
  });
}

/** V32 distinguishes Snapshot V16's complete target-group closure and ordered
 * same-unit conclusion resolution from V31. Receipt content and seven-call
 * invariants remain unchanged. */
export function groundSettledKnowledgeAnswerV32(
  input: KnowledgeGroundingV25Input
): KnowledgeGroundingEvidenceV32 {
  const grounded = groundSettledKnowledgeAnswerV31(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V32
  });
}

/** V33 distinguishes Snapshot V17's verifier-directed Scope patch merge from
 * V32. Only independently rejected JSON-pointer paths may change; receipt
 * content and seven-call invariants remain unchanged. */
export function groundSettledKnowledgeAnswerV33(
  input: KnowledgeGroundingV25Input
): KnowledgeGroundingEvidenceV33 {
  const grounded = groundSettledKnowledgeAnswerV32(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V33
  });
}

type KnowledgeGroundingV34Input = Omit<
  KnowledgeGroundingV25Input,
  "operations"
> & Readonly<{
  closure: Readonly<{
    initialCoveredDimensionCount: number;
    payloadHash: string;
    reopenedDimensionCount: number;
  }> | null;
  operations: readonly KnowledgeGroundingOperationEvidenceV34[];
}>;

function validGroundingOperationV34(
  operation: KnowledgeGroundingOperationEvidenceV34 |
    KnowledgeGroundingOperationEvidenceV35,
  ordinal: number
): boolean {
  const purpose = operation.role === "primary"
    ? KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
    : operation.role === "scope" || operation.role === "scope_repair"
      ? KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
      : operation.role === "scope_completeness" ||
          operation.role === "scope_completeness_repair"
        ? KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
        : operation.role === "initial" || operation.role === "repair"
          ? KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
          : operation.role === "scope_closure" ||
              operation.role === "scope_closure_repair"
            ? KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
            : operation.role === "supplement"
              ? KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
              : KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21;
  const contractVersion = operation.role === "scope" || operation.role === "scope_repair"
    ? 6
    : operation.role === "scope_completeness" ||
        operation.role === "scope_completeness_repair" ||
        operation.role === "scope_closure" || operation.role === "scope_closure_repair"
      ? 1
      : 21;
  const usage = decodeKnowledgeProviderAttemptUsage(operation.usage);
  return operation.ordinal === ordinal && operation.purpose === purpose &&
    operation.contractVersion === contractVersion &&
    validOperationId(operation.operationId) && validDuration(operation.durationMs) &&
    /^[0-9a-f]{64}$/u.test(operation.acceptedRequestHash) &&
    /^[0-9a-f]{64}$/u.test(operation.acceptedResultHash) &&
    (operation.providerRequestId === null || operation.providerRequestId.length <= 1_024) &&
    Boolean(usage && usage.inputTokens !== null && usage.outputTokens !== null);
}

/** V34 attests Snapshot V18's independent post-Selector semantic closure veto.
 * The receipt remains content-free: it records only operation hashes, aggregate
 * closure counts, timings, usage, and the pre-existing settlement aggregates. */
export function groundSettledKnowledgeAnswerV34(
  input: KnowledgeGroundingV34Input
): KnowledgeGroundingEvidenceV34 {
  const roleSequences: KnowledgeGroundingOperationEvidenceV34["role"][][] = [];
  for (const scopeRepair of [false, true]) {
    for (const completenessRepair of [false, true]) {
      for (const selectorRepair of [false, true]) {
        const base: KnowledgeGroundingOperationEvidenceV34["role"][] = [
          "primary",
          "scope",
          ...(scopeRepair ? ["scope_repair" as const] : []),
          "scope_completeness",
          ...(completenessRepair ? ["scope_completeness_repair" as const] : []),
          "initial",
          ...(selectorRepair ? ["repair" as const] : [])
        ];
        for (const closureCount of [0, 1, 2] as const) {
          const closureGated = [
            ...base,
            ...Array.from({ length: closureCount }, (_unused, index) =>
              index === 0 ? "scope_closure" as const : "scope_closure_repair" as const)
          ];
          if (closureGated.length <= 7) roleSequences.push(closureGated);
          if (closureGated.length + 2 <= 7) {
            roleSequences.push(
              [...closureGated, "supplement"],
              [...closureGated, "supplement", "final"]
            );
          }
        }
      }
    }
  }
  const roles = input.operations.map(({ role }) => role);
  const validSequence = roleSequences.some((sequence) =>
    JSON.stringify(sequence) === JSON.stringify(roles));
  const operationsValid = validSequence && input.operations.length <= 7 &&
    input.operations.every((operation, index) =>
      validGroundingOperationV34(operation, index + 1));
  const closureOperations = input.operations.filter(({ role }) =>
    role === "scope_closure" || role === "scope_closure_repair");
  const closureRepairAttempted = roles.includes("scope_closure_repair");
  const acceptedClosure = closureOperations.at(-1);
  const closureValid = input.closure === null
    ? closureOperations.length === 0 && input.coverage.coveredDimensionCount === 0
    : closureOperations.length >= 1 && closureOperations.length <= 2 &&
      Number.isSafeInteger(input.closure.initialCoveredDimensionCount) &&
      input.closure.initialCoveredDimensionCount >= 1 &&
      input.closure.initialCoveredDimensionCount <= input.coverageScope.dimensionCount &&
      Number.isSafeInteger(input.closure.reopenedDimensionCount) &&
      input.closure.reopenedDimensionCount >= 0 &&
      input.closure.reopenedDimensionCount <= input.closure.initialCoveredDimensionCount &&
      input.coverage.coveredDimensionCount ===
        input.closure.initialCoveredDimensionCount - input.closure.reopenedDimensionCount &&
      /^[0-9a-f]{64}$/u.test(input.closure.payloadHash) &&
      input.closure.payloadHash === acceptedClosure?.acceptedResultHash &&
      closureRepairAttempted === (closureOperations.length === 2);
  if (!operationsValid || !closureValid) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted Scope-closure grounding evidence is invalid"
    );
  }
  const historicalOperations = input.operations
    .filter(({ role }) => role !== "scope_closure" && role !== "scope_closure_repair")
    .map((operation, index) => Object.freeze({
      ...operation,
      ordinal: index + 1 as 1 | 2 | 3 | 4 | 5 | 6 | 7,
      usage: Object.freeze({ ...operation.usage })
    })) as readonly KnowledgeGroundingOperationEvidenceV25[];
  const { closure: _closure, operations: _operations, ...shared } = input;
  void _closure;
  void _operations;
  const historical = groundSettledKnowledgeAnswerV33({
    ...shared,
    operations: historicalOperations
  });
  const operations = Object.freeze(input.operations.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  return Object.freeze({
    ...historical,
    closure: input.closure === null
      ? null
      : Object.freeze({ ...input.closure, status: "accepted" as const }),
    closureRepairAttempted,
    closureRepairSucceeded: closureRepairAttempted,
    operations,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V34
  });
}

type KnowledgeGroundingV35Input = Omit<
  KnowledgeGroundingV34Input,
  "operations"
> & Readonly<{
  operations: readonly KnowledgeGroundingOperationEvidenceV35[];
}>;

/** V35 attests Snapshot V19's repair-reserved correction budget. The normal
 * closure path remains five calls; after any one adjacent structural repair,
 * the complete Supplement/final-Selector pair still fits under the bounded
 * eight-operation ceiling. */
export function groundSettledKnowledgeAnswerV35(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV35 {
  const roleSequences: KnowledgeGroundingOperationEvidenceV35["role"][][] = [];
  for (const scopeRepair of [false, true]) {
    for (const completenessRepair of [false, true]) {
      for (const selectorRepair of [false, true]) {
        const base: KnowledgeGroundingOperationEvidenceV35["role"][] = [
          "primary",
          "scope",
          ...(scopeRepair ? ["scope_repair" as const] : []),
          "scope_completeness",
          ...(completenessRepair ? ["scope_completeness_repair" as const] : []),
          "initial",
          ...(selectorRepair ? ["repair" as const] : [])
        ];
        for (const closureCount of [0, 1, 2] as const) {
          const closureGated = [
            ...base,
            ...Array.from({ length: closureCount }, (_unused, index) =>
              index === 0 ? "scope_closure" as const : "scope_closure_repair" as const)
          ];
          if (closureGated.length <=
            KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2) {
            roleSequences.push(closureGated);
          }
          if (knowledgeAnswerScopeV6CorrectionFitsV2(closureGated.length)) {
            roleSequences.push(
              [...closureGated, "supplement"],
              [...closureGated, "supplement", "final"]
            );
          }
        }
      }
    }
  }
  const roles = input.operations.map(({ role }) => role);
  const validSequence = roleSequences.some((sequence) =>
    JSON.stringify(sequence) === JSON.stringify(roles));
  const operationsValid = validSequence && input.operations.length <=
    KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2 &&
    input.operations.every((operation, index) =>
      validGroundingOperationV34(operation, index + 1));
  const closureOperations = input.operations.filter(({ role }) =>
    role === "scope_closure" || role === "scope_closure_repair");
  const closureRepairAttempted = roles.includes("scope_closure_repair");
  const acceptedClosure = closureOperations.at(-1);
  const closureValid = input.closure === null
    ? closureOperations.length === 0 && input.coverage.coveredDimensionCount === 0
    : closureOperations.length >= 1 && closureOperations.length <= 2 &&
      Number.isSafeInteger(input.closure.initialCoveredDimensionCount) &&
      input.closure.initialCoveredDimensionCount >= 1 &&
      input.closure.initialCoveredDimensionCount <= input.coverageScope.dimensionCount &&
      Number.isSafeInteger(input.closure.reopenedDimensionCount) &&
      input.closure.reopenedDimensionCount >= 0 &&
      input.closure.reopenedDimensionCount <= input.closure.initialCoveredDimensionCount &&
      input.coverage.coveredDimensionCount ===
        input.closure.initialCoveredDimensionCount - input.closure.reopenedDimensionCount &&
      /^[0-9a-f]{64}$/u.test(input.closure.payloadHash) &&
      input.closure.payloadHash === acceptedClosure?.acceptedResultHash &&
      closureRepairAttempted === (closureOperations.length === 2);
  if (!operationsValid || !closureValid) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted repair-reserved Scope-closure grounding evidence is invalid"
    );
  }
  const baseOperations = input.operations
    .filter(({ role }) => role !== "scope_closure" && role !== "scope_closure_repair")
    .map((operation, index) => Object.freeze({
      ...operation,
      ordinal: index + 1 as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
      purpose: operation.purpose as KnowledgeAnswerOperationScopeV6CompletenessV1,
      role: operation.role as KnowledgeGroundingOperationEvidenceRepairBudgetV2["role"],
      usage: Object.freeze({ ...operation.usage })
    })) as readonly KnowledgeGroundingOperationEvidenceRepairBudgetV2[];
  const { closure: _closure, operations: _operations, ...shared } = input;
  void _closure;
  void _operations;
  const grounded = groundSettledKnowledgeAnswerRepairBudget({
    ...shared,
    operations: baseOperations
  }, KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2);
  const operations = Object.freeze(input.operations.map((operation) => Object.freeze({
    ...operation,
    usage: Object.freeze({ ...operation.usage })
  })));
  return Object.freeze({
    ...grounded,
    closure: input.closure === null
      ? null
      : Object.freeze({ ...input.closure, status: "accepted" as const }),
    closureRepairAttempted,
    closureRepairSucceeded: closureRepairAttempted,
    operations,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V35
  });
}

/** V36 attests Snapshot V20's trusted source-ordered contextual evidence
 * projection. Receipt contents and the bounded eight-operation state machine
 * stay identical to V35; the version prevents historical runs from being
 * reinterpreted with the new atom coordinates. */
export function groundSettledKnowledgeAnswerV36(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV36 {
  const grounded = groundSettledKnowledgeAnswerV35(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V36
  });
}

/** V37 attests Snapshot V21's target-only least-authority delta verifier.
 * Receipt contents and the bounded eight-operation state machine stay
 * identical to V36; the version prevents historical final-Selector prompts
 * from being reinterpreted with target-veto authority. */
export function groundSettledKnowledgeAnswerV37(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV37 {
  const grounded = groundSettledKnowledgeAnswerV36(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V37
  });
}

/** V38 attests Snapshot V22's fail-closed local provenance rejection.  A
 * foreign-atom local finding is discarded in full and the remaining Scope is
 * revalidated; receipt contents and the bounded state machine stay identical
 * to V37. */
export function groundSettledKnowledgeAnswerV38(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV38 {
  const grounded = groundSettledKnowledgeAnswerV37(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V38
  });
}

/** V39 attests Snapshot V23's one bounded final-delta consistency review.
 * Receipt contents and the eight-operation hard cap stay identical to V38;
 * the version prevents historical final verifiers from acquiring retry
 * semantics. */
export function groundSettledKnowledgeAnswerV39(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV39 {
  const roles = input.operations.map(({ role }) => role);
  const finalIndexes = roles.flatMap((role, index) => role === "final" ? [index] : []);
  const finalRepair = finalIndexes.length === 2 &&
    finalIndexes[0] === input.operations.length - 2 &&
    finalIndexes[1] === input.operations.length - 1 &&
    roles.at(-3) === "supplement";
  if (!finalRepair) {
    const grounded = groundSettledKnowledgeAnswerV38(input);
    return Object.freeze({
      ...grounded,
      version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V39
    });
  }
  const operationsValid = input.operations.length <=
    KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2 &&
    input.operations.every((operation, index) =>
      validGroundingOperationV34(operation, index + 1));
  if (!operationsValid) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted final-delta repair grounding evidence is invalid"
    );
  }
  const historicalOperations = input.operations
    .filter((_operation, index) => index !== finalIndexes[0])
    .map((operation, index) => Object.freeze({
      ...operation,
      ordinal: index + 1 as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
      usage: Object.freeze({ ...operation.usage })
    })) as readonly KnowledgeGroundingOperationEvidenceV35[];
  const grounded = groundSettledKnowledgeAnswerV38({
    ...input,
    operations: historicalOperations
  });
  return Object.freeze({
    ...grounded,
    operations: Object.freeze(input.operations.map((operation) => Object.freeze({
      ...operation,
      usage: Object.freeze({ ...operation.usage })
    }))),
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V39
  });
}

/** V40 attests Snapshot V24's atomic targeted-supplement publication contract.
 * Receipt contents and the eight-operation hard cap stay identical to V39;
 * the version prevents historical grouped supplements from acquiring the new
 * one-proposition and connector-entailment rules. */
export function groundSettledKnowledgeAnswerV40(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV40 {
  const grounded = groundSettledKnowledgeAnswerV39(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V40
  });
}

/** V41 attests Snapshot V25's single-call multi-diagnostic Scope repair.
 * Receipt contents and the eight-operation hard cap stay identical to V40;
 * the version prevents historical first-error prompts from acquiring the new
 * bounded diagnostic-set semantics. */
export function groundSettledKnowledgeAnswerV41(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV41 {
  const grounded = groundSettledKnowledgeAnswerV40(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V41
  });
}

/** V42 attests Snapshot V26's repair-only, content-free initial Selector
 * diagnostic. Receipt contents and the bounded operation graph stay identical
 * to V41; historical broad-reason repairs keep their original prompts. */
export function groundSettledKnowledgeAnswerV42(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV42 {
  const grounded = groundSettledKnowledgeAnswerV41(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V42
  });
}

/** V43 attests Snapshot V27's deterministic fail-closed Selector edge
 * normalization. Receipt contents and the bounded operation graph stay
 * identical to V42; historical unknown-edge failures remain strict. */
export function groundSettledKnowledgeAnswerV43(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV43 {
  const grounded = groundSettledKnowledgeAnswerV42(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V43
  });
}

/** V44 attests Snapshot V28's target-count-aware atomic Supplement capacity.
 * Receipt contents and the bounded operation graph stay identical to V43;
 * historical flat 12-claim allocations retain their exact schemas. */
export function groundSettledKnowledgeAnswerV44(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV44 {
  const grounded = groundSettledKnowledgeAnswerV43(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V44
  });
}

/** V45 attests Snapshot V29's query-intent-preserving Scope and append-only
 * completeness prompts. Receipt contents and operation count stay identical
 * to V44; historical prompt bytes retain their exact semantics. */
export function groundSettledKnowledgeAnswerV45(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV45 {
  const grounded = groundSettledKnowledgeAnswerV44(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V45
  });
}

/** V46 attests Snapshot V30's query-granularity and epistemic-fidelity
 * prompts. Receipt contents and operation count stay identical to V45;
 * historical relevance and modality instructions retain their exact bytes. */
export function groundSettledKnowledgeAnswerV46(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV46 {
  const grounded = groundSettledKnowledgeAnswerV45(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V46
  });
}

/** V47 attests Snapshot V31's answer-level compression and server-issued
 * request-anchor-ID prompts. Receipt contents and operation count stay
 * identical to V46; historical prompts keep their exact query-granularity and
 * epistemic-fidelity semantics. */
export function groundSettledKnowledgeAnswerV47(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV47 {
  const grounded = groundSettledKnowledgeAnswerV46(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V47
  });
}

/** V48 attests Snapshot V32's model-owned set reduction across Scope and the
 * global Selector. Receipt contents and operation count stay identical to
 * V47; the server neither semantically merges requirements nor transfers
 * provenance between them. */
export function groundSettledKnowledgeAnswerV48(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV48 {
  const grounded = groundSettledKnowledgeAnswerV47(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V48
  });
}

/** V49 attests Snapshot V33's recall-first Scope map and Selector-owned global
 * redundancy reduction. Receipt contents and operation count stay identical
 * to V48; zero-dimension and provenance validators remain unchanged. */
export function groundSettledKnowledgeAnswerV49(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV49 {
  const grounded = groundSettledKnowledgeAnswerV48(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V49
  });
}

/** V50 attests Snapshot V34's fail-closed whole-item rejection for local or
 * joint findings with structurally invalid provenance. Receipt contents and
 * operation count stay identical to V49; no finding is moved or repaired. */
export function groundSettledKnowledgeAnswerV50(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV50 {
  const grounded = groundSettledKnowledgeAnswerV49(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V50
  });
}

/** V51 attests Snapshot V35's global no-data supersession, exact primary
 * duplicate reduction inside grouped Supplements, primary-Draft co-equal
 * facet atomization, and target-local accumulative reduce over revalidated
 * primary map points plus generated deltas. Receipt contents and the bounded
 * operation graph stay identical to V50; no semantic server-side merge,
 * coverage promotion, or additional model operation is introduced. */
export function groundSettledKnowledgeAnswerV51(
  input: KnowledgeGroundingV35Input
): KnowledgeGroundingEvidenceV51 {
  const grounded = groundSettledKnowledgeAnswerV50(input);
  return Object.freeze({
    ...grounded,
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V51
  });
}

type KnowledgeGroundingV52Input = Omit<
  KnowledgeGroundingV35Input,
  "closure" | "operations"
> & Readonly<{
  closure: Readonly<{
    initialCoveredDimensionCount: number;
    initialExcludedDimensionCount: number;
    payloadHash: string;
    reopenedCoveredDimensionCount: number;
    reopenedDimensionCount: number;
    reopenedExcludedDimensionCount: number;
  }> | null;
  operations: readonly KnowledgeGroundingOperationEvidenceV52[];
}>;

/** V52 attests Snapshot V36's holistic reduction-safety audit. The closure can
 * only reopen a covered or excluded Scope dimension to missing; separate
 * aggregate counters make both monotone transitions recoverable without
 * storing query, evidence, Scope, or answer content. The historical V51
 * projection retains the same bounded operation graph and all prior receipt
 * invariants. */
export function groundSettledKnowledgeAnswerV52(
  input: KnowledgeGroundingV52Input
): KnowledgeGroundingEvidenceV52 {
  const closureOperations = input.operations.filter(({ role }) =>
    role === "scope_closure" || role === "scope_closure_repair");
  const acceptedClosure = closureOperations.at(-1);
  const operationPurposesValid = input.operations.every((operation) => {
    const closureRole = operation.role === "scope_closure" ||
      operation.role === "scope_closure_repair";
    return closureRole
      ? operation.purpose === KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_V2_OPERATION &&
          operation.contractVersion === 2
      : operation.purpose !== KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_V2_OPERATION;
  });
  const closureValid = input.closure === null
    ? closureOperations.length === 0
    : closureOperations.length >= 1 && closureOperations.length <= 2 &&
      Number.isSafeInteger(input.closure.initialCoveredDimensionCount) &&
      input.closure.initialCoveredDimensionCount >= 1 &&
      Number.isSafeInteger(input.closure.initialExcludedDimensionCount) &&
      input.closure.initialExcludedDimensionCount >= 0 &&
      input.closure.initialCoveredDimensionCount +
        input.closure.initialExcludedDimensionCount <=
        input.coverageScope.dimensionCount &&
      Number.isSafeInteger(input.closure.reopenedCoveredDimensionCount) &&
      input.closure.reopenedCoveredDimensionCount >= 0 &&
      input.closure.reopenedCoveredDimensionCount <=
        input.closure.initialCoveredDimensionCount &&
      Number.isSafeInteger(input.closure.reopenedExcludedDimensionCount) &&
      input.closure.reopenedExcludedDimensionCount >= 0 &&
      input.closure.reopenedExcludedDimensionCount <=
        input.closure.initialExcludedDimensionCount &&
      Number.isSafeInteger(input.closure.reopenedDimensionCount) &&
      input.closure.reopenedDimensionCount ===
        input.closure.reopenedCoveredDimensionCount +
          input.closure.reopenedExcludedDimensionCount &&
      input.coverage.coveredDimensionCount ===
        input.closure.initialCoveredDimensionCount -
          input.closure.reopenedCoveredDimensionCount &&
      input.coverage.excludedDimensionCount ===
        input.closure.initialExcludedDimensionCount -
          input.closure.reopenedExcludedDimensionCount &&
      /^[0-9a-f]{64}$/u.test(input.closure.payloadHash) &&
      input.closure.payloadHash === acceptedClosure?.acceptedResultHash;
  if (!operationPurposesValid || !closureValid) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted holistic Scope-closure grounding evidence is invalid"
    );
  }
  const projectedOperations = input.operations.map((operation) => Object.freeze({
    ...operation,
    ...(operation.role === "scope_closure" || operation.role === "scope_closure_repair"
      ? {
          contractVersion: 1 as const,
          purpose: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
        }
      : {}),
    usage: Object.freeze({ ...operation.usage })
  })) as readonly KnowledgeGroundingOperationEvidenceV51[];
  const grounded = groundSettledKnowledgeAnswerV51({
    ...input,
    closure: input.closure === null
      ? null
      : {
          initialCoveredDimensionCount: input.closure.initialCoveredDimensionCount,
          payloadHash: input.closure.payloadHash,
          reopenedDimensionCount: input.closure.reopenedCoveredDimensionCount
        },
    operations: projectedOperations
  });
  return Object.freeze({
    ...grounded,
    closure: input.closure === null
      ? null
      : Object.freeze({ ...input.closure, status: "accepted" as const }),
    operations: Object.freeze(input.operations.map((operation) => Object.freeze({
      ...operation,
      usage: Object.freeze({ ...operation.usage })
    }))),
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V52
  });
}

/** V53 attests Snapshot V37's non-missing closure admission. Unlike V52, an
 * all-excluded Selector must still produce a closure receipt, while an
 * all-missing Selector must not. The persisted shape stays content-free and
 * unchanged; the new version prevents historical V52 runs that skipped this
 * audit from being reinterpreted under the repaired scheduler. */
export function groundSettledKnowledgeAnswerV53(
  input: KnowledgeGroundingV52Input
): KnowledgeGroundingEvidenceV53 {
  const roles = input.operations.map(({ role }) => role);
  const closureOperations = input.operations.filter(({ role }) =>
    role === "scope_closure" || role === "scope_closure_repair");
  const acceptedClosure = closureOperations.at(-1);
  const operationPurposesValid = input.operations.every((operation) => {
    const closureRole = operation.role === "scope_closure" ||
      operation.role === "scope_closure_repair";
    return closureRole
      ? operation.purpose === KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_V2_OPERATION &&
          operation.contractVersion === 2
      : operation.purpose !== KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_V2_OPERATION;
  });
  const projectedOperations = input.operations.map((operation) => Object.freeze({
    ...operation,
    ...(operation.role === "scope_closure" || operation.role === "scope_closure_repair"
      ? {
          contractVersion: 1 as const,
          purpose: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
        }
      : {}),
    usage: Object.freeze({ ...operation.usage })
  })) as readonly KnowledgeGroundingOperationEvidenceV51[];
  const operationReceiptsValid = projectedOperations.length <=
    KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2 &&
    projectedOperations.every((operation, index) =>
      validGroundingOperationV34(operation, index + 1));
  const firstClosureIndex = roles.indexOf("scope_closure");
  const closureBlockValid = closureOperations.length === 0
    ? firstClosureIndex === -1 && !roles.includes("scope_closure_repair")
    : firstClosureIndex >= 1 && closureOperations.length <= 2 &&
      (roles[firstClosureIndex - 1] === "initial" ||
        roles[firstClosureIndex - 1] === "repair") &&
      (closureOperations.length === 1 ||
        roles[firstClosureIndex + 1] === "scope_closure_repair") &&
      (firstClosureIndex + closureOperations.length === roles.length ||
        roles[firstClosureIndex + closureOperations.length] === "supplement");
  const closureValid = input.closure === null
    ? closureOperations.length === 0 &&
      input.coverage.coveredDimensionCount === 0 &&
      input.coverage.excludedDimensionCount === 0
    : closureOperations.length >= 1 && closureOperations.length <= 2 &&
      Number.isSafeInteger(input.closure.initialCoveredDimensionCount) &&
      input.closure.initialCoveredDimensionCount >= 0 &&
      Number.isSafeInteger(input.closure.initialExcludedDimensionCount) &&
      input.closure.initialExcludedDimensionCount >= 0 &&
      input.closure.initialCoveredDimensionCount +
        input.closure.initialExcludedDimensionCount >= 1 &&
      input.closure.initialCoveredDimensionCount +
        input.closure.initialExcludedDimensionCount <=
        input.coverageScope.dimensionCount &&
      Number.isSafeInteger(input.closure.reopenedCoveredDimensionCount) &&
      input.closure.reopenedCoveredDimensionCount >= 0 &&
      input.closure.reopenedCoveredDimensionCount <=
        input.closure.initialCoveredDimensionCount &&
      Number.isSafeInteger(input.closure.reopenedExcludedDimensionCount) &&
      input.closure.reopenedExcludedDimensionCount >= 0 &&
      input.closure.reopenedExcludedDimensionCount <=
        input.closure.initialExcludedDimensionCount &&
      Number.isSafeInteger(input.closure.reopenedDimensionCount) &&
      input.closure.reopenedDimensionCount ===
        input.closure.reopenedCoveredDimensionCount +
          input.closure.reopenedExcludedDimensionCount &&
      input.coverage.coveredDimensionCount ===
        input.closure.initialCoveredDimensionCount -
          input.closure.reopenedCoveredDimensionCount &&
      input.coverage.excludedDimensionCount ===
        input.closure.initialExcludedDimensionCount -
          input.closure.reopenedExcludedDimensionCount &&
      /^[0-9a-f]{64}$/u.test(input.closure.payloadHash) &&
      input.closure.payloadHash === acceptedClosure?.acceptedResultHash;
  if (!operationPurposesValid || !operationReceiptsValid ||
    !closureBlockValid || !closureValid) {
    throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed",
      "The accepted non-missing Scope-closure grounding evidence is invalid"
    );
  }
  const allExcludedAdmission = input.closure !== null &&
    input.closure.initialCoveredDimensionCount === 0;
  // V51 remains the owner of the historical non-Closure state machine. For the
  // new all-excluded admission, remove the already validated V2 Closure block
  // and renumber only this internal historical projection; unlike a fabricated
  // covered counter, this preserves the actual V53 coverage semantics.
  const historicalOperations = allExcludedAdmission
    ? projectedOperations
        .filter(({ role }) => role !== "scope_closure" &&
          role !== "scope_closure_repair")
        .map((operation, index) => Object.freeze({
          ...operation,
          ordinal: index + 1 as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
        })) as readonly KnowledgeGroundingOperationEvidenceV51[]
    : projectedOperations;
  const historicalClosure = input.closure === null || allExcludedAdmission
    ? null
    : {
        initialCoveredDimensionCount: input.closure.initialCoveredDimensionCount,
        payloadHash: input.closure.payloadHash,
        reopenedDimensionCount: input.closure.reopenedCoveredDimensionCount
      };
  const grounded = groundSettledKnowledgeAnswerV51({
    ...input,
    closure: historicalClosure,
    operations: historicalOperations
  });
  const closureRepairAttempted = roles.includes("scope_closure_repair");
  return Object.freeze({
    ...grounded,
    closure: input.closure === null
      ? null
      : Object.freeze({ ...input.closure, status: "accepted" as const }),
    closureRepairAttempted,
    closureRepairSucceeded: closureRepairAttempted,
    operations: Object.freeze(input.operations.map((operation) => Object.freeze({
      ...operation,
      usage: Object.freeze({ ...operation.usage })
    }))),
    version: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V53
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
