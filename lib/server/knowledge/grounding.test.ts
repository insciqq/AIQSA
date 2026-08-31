import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  type KnowledgeEvidencePackage
} from "./evidencePackage";
import {
  groundKnowledgeAnswer,
  groundSettledKnowledgeAnswerV5,
  groundSettledKnowledgeAnswerV8,
  groundSettledKnowledgeAnswerV9,
  groundSettledKnowledgeAnswerV10,
  groundSettledKnowledgeAnswerV11,
  groundSettledKnowledgeAnswerV12,
  groundSettledKnowledgeAnswerV13,
  groundSettledKnowledgeAnswerV14,
  groundSettledKnowledgeAnswerV15,
  groundSettledKnowledgeAnswerV16,
  groundSettledKnowledgeAnswerV17,
  groundKnowledgeToolLoopAnswer,
  KnowledgeAnswerContractError
} from "./grounding";
import type { KnowledgeAnswerSettlementV5 } from "./answerGroundingV5";

const privateSourceId = "2e3aa829-79cd-41df-b5c7-1a53f4b5cf19";

function evidence(): KnowledgeEvidencePackage {
  return {
    citationContract: KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
    coverage: { expectedPassageCount: null, mode: "partial", namedTargets: [], verified: false },
    degradedFlags: [],
    items: [{
      baseName: "Base",
      contentHash: "a".repeat(64),
      contextBoundaries: {
        expanded: false,
        excerptBytes: 8,
        sourceTextBytes: 8
      },
      documentId: "source-1",
      documentVersionId: "version-1",
      excerpt: "Evidence",
      fileName: "source.txt",
      handle: "K1",
      headingPath: [],
      id: "evidence-1",
      knowledgeBaseId: "base-1",
      locator: { page: 1 },
      ordinal: 1,
      passageId: "passage-1",
      provenance: [],
      sectionId: null,
      sourceArtifactId: "artifact-1",
      sourceId: privateSourceId,
      sourceName: "Source",
      sourceVersionId: "version-1",
      sourceVersionNumber: 1,
      state: "available",
      textTruncated: false
    }],
    originalIntent: { kind: "focused_v1", query: "Вопрос" },
    readiness: { excludedResources: 0, readyBases: 1, readySources: 1 },
    runId: "run-1",
    scopeSnapshot: {},
    sessionId: "session-1",
    version: 2
  };
}

function toolLoopEvidence(): KnowledgeEvidencePackage {
  const base = evidence();
  return {
    ...base,
    items: [
      ...base.items,
      {
        ...base.items[0]!,
        handle: "K2",
        id: "evidence-2",
        ordinal: 2,
        passageId: "passage-2"
      }
    ],
    originalIntent: { kind: "tool_loop_v1" }
  };
}

describe("Knowledge answer citation contract", () => {
  it("records content-free Grounding Evidence V7 for deterministic settlement", () => {
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12
    };
    const settlement: KnowledgeAnswerSettlementV5 = {
      contradictedClaimCount: 0,
      fallbackReason: null,
      finalText: "Supported fact. [K1]",
      finalizationMode: "selected_claims",
      groundingStatus: "verified",
      outcome: "answered",
      requestCoverage: "complete",
      supportedClaimCount: 1,
      unsupportedClaimCount: 0
    };
    const result = groundSettledKnowledgeAnswerV5({
      contracts: {
        draftContractVersion: 11,
        selectorContractVersion: 7
      },
      draft: {
        claimCount: 1,
        durationMs: 120,
        hash: "a".repeat(64),
        operationId: "draft-operation-0001",
        providerRequestId: "draft-response-1",
        usage
      },
      evidence: evidence(),
      evidenceReceiptHash: "c".repeat(64),
      selector: {
        durationMs: 80,
        hash: "b".repeat(64),
        operationId: "selector-operation-0001",
        providerRequestId: "selector-response-1",
        usage
      },
      settlement
    });

    expect(result).toMatchObject({
      draftClaimCount: 1,
      draftContractVersion: 11,
      finalizationMode: "selected_claims",
      requestCoverage: "complete",
      selectorContractVersion: 7,
      version: 7
    });
    expect(result.evidenceReceiptHash).toBe("c".repeat(64));
    expect(JSON.stringify(result)).not.toContain("Evidence");
    expect(result.finalAnswerHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("records every bounded adaptive operation in content-free Grounding Evidence V8", () => {
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12
    };
    const operation = (input: Readonly<{
      claimCount: number | null;
      role: "final" | "initial" | "primary" | "supplement";
      suffix: string;
    }>) => ({
      claimCount: input.claimCount,
      durationMs: 20,
      hash: input.suffix.repeat(64),
      operationId: `operation-${input.role}-0001`,
      providerRequestId: `provider-${input.role}`,
      role: input.role,
      usage
    });
    const result = groundSettledKnowledgeAnswerV8({
      contracts: { draftContractVersion: 12, selectorContractVersion: 8 },
      draftClaimCount: 2,
      drafts: [
        operation({ claimCount: 1, role: "primary", suffix: "a" }),
        operation({ claimCount: 1, role: "supplement", suffix: "b" })
      ],
      evidence: evidence(),
      evidenceReceiptHash: "c".repeat(64),
      selectors: [
        operation({ claimCount: null, role: "initial", suffix: "d" }),
        operation({ claimCount: null, role: "final", suffix: "e" })
      ],
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Supported fact. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 2,
        unsupportedClaimCount: 0
      }
    });

    expect(result).toMatchObject({
      adaptiveCorrectionApplied: true,
      correctionCompleted: true,
      draftContractVersion: 12,
      selectorContractVersion: 8,
      version: 8
    });
    expect(result.drafts.map(({ role }) => role)).toEqual(["primary", "supplement"]);
    expect(result.selectors.map(({ role }) => role)).toEqual(["initial", "final"]);
    expect(JSON.stringify(result)).not.toContain("Evidence");
  });

  it("records V13/V9 atomic-entailment operations in content-free Grounding Evidence V9", () => {
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12
    };
    const operation = (input: Readonly<{
      claimCount: number | null;
      role: "final" | "initial" | "primary" | "supplement";
      suffix: string;
    }>) => ({
      claimCount: input.claimCount,
      durationMs: 20,
      hash: input.suffix.repeat(64),
      operationId: `operation-${input.role}-0001`,
      providerRequestId: `provider-${input.role}`,
      role: input.role,
      usage
    });
    const result = groundSettledKnowledgeAnswerV9({
      contracts: { draftContractVersion: 13, selectorContractVersion: 9 },
      draftClaimCount: 2,
      drafts: [
        operation({ claimCount: 1, role: "primary", suffix: "a" }),
        operation({ claimCount: 1, role: "supplement", suffix: "b" })
      ],
      evidence: evidence(),
      evidenceReceiptHash: "c".repeat(64),
      selectors: [
        operation({ claimCount: null, role: "initial", suffix: "d" }),
        operation({ claimCount: null, role: "final", suffix: "e" })
      ],
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Supported fact. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 2,
        unsupportedClaimCount: 0
      }
    });

    expect(result).toMatchObject({
      adaptiveCorrectionApplied: true,
      correctionCompleted: true,
      draftContractVersion: 13,
      selectorContractVersion: 9,
      version: 9
    });
    expect(result.drafts.map(({ role }) => role)).toEqual(["primary", "supplement"]);
    expect(result.selectors.map(({ role }) => role)).toEqual(["initial", "final"]);
    expect(JSON.stringify(result)).not.toContain("Evidence");
  });

  it("records V14/V10 required-dimension operations in content-free Grounding Evidence V10", () => {
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12
    };
    const operation = (input: Readonly<{
      claimCount: number | null;
      role: "initial" | "primary";
      suffix: string;
    }>) => ({
      claimCount: input.claimCount,
      durationMs: 20,
      hash: input.suffix.repeat(64),
      operationId: `operation-${input.role}-0001`,
      providerRequestId: `provider-${input.role}`,
      role: input.role,
      usage
    });
    const result = groundSettledKnowledgeAnswerV10({
      contracts: { draftContractVersion: 14, selectorContractVersion: 10 },
      draftClaimCount: 1,
      drafts: [operation({ claimCount: 1, role: "primary", suffix: "a" })],
      evidence: evidence(),
      evidenceReceiptHash: "c".repeat(64),
      selectors: [operation({ claimCount: null, role: "initial", suffix: "d" })],
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Supported fact. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 1,
        unsupportedClaimCount: 0
      }
    });

    expect(result).toMatchObject({
      adaptiveCorrectionApplied: false,
      correctionCompleted: false,
      draftContractVersion: 14,
      selectorContractVersion: 10,
      version: 10
    });
    expect(JSON.stringify(result)).not.toContain("The defining mechanism");
  });

  it("records one V15/V11 validation repair without conflating it with coverage correction", () => {
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12
    };
    const operation = (
      role: "initial" | "primary" | "repair" | "supplement",
      claimCount: number | null,
      suffix: string
    ) => ({
      claimCount,
      durationMs: 20,
      hash: suffix.repeat(64),
      operationId: `operation-${role}-0001`,
      providerRequestId: `provider-${role}`,
      role,
      usage
    });
    const settlement: KnowledgeAnswerSettlementV5 = {
      contradictedClaimCount: 0,
      fallbackReason: null,
      finalText: "Supported fact. [K1]",
      finalizationMode: "selected_claims",
      groundingStatus: "verified",
      outcome: "answered",
      requestCoverage: "complete",
      supportedClaimCount: 1,
      unsupportedClaimCount: 0
    };
    const result = groundSettledKnowledgeAnswerV11({
      contracts: { draftContractVersion: 15, selectorContractVersion: 11 },
      draftClaimCount: 1,
      drafts: [operation("primary", 1, "a")],
      evidence: evidence(),
      evidenceReceiptHash: "c".repeat(64),
      selectors: [
        operation("initial", null, "d"),
        operation("repair", null, "e")
      ],
      settlement
    });

    expect(result).toMatchObject({
      adaptiveCorrectionApplied: false,
      correctionCompleted: false,
      draftContractVersion: 15,
      selectorContractVersion: 11,
      selectorValidationRepairApplied: true,
      selectorValidationRepairCompleted: true,
      version: 11
    });
    expect(result.selectors.map(({ role }) => role)).toEqual(["initial", "repair"]);
    expect(() => groundSettledKnowledgeAnswerV11({
      contracts: { draftContractVersion: 15, selectorContractVersion: 11 },
      draftClaimCount: 2,
      drafts: [
        operation("primary", 1, "a"),
        operation("supplement", 1, "b")
      ],
      evidence: evidence(),
      evidenceReceiptHash: "c".repeat(64),
      selectors: [
        operation("initial", null, "d"),
        operation("repair", null, "e")
      ],
      settlement
    })).toThrow(KnowledgeAnswerContractError);
  });

  it("records V16/V12 quantitative-coverage operations in content-free Grounding Evidence V12", () => {
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12
    };
    const operation = (role: "initial" | "primary", claimCount: number | null, suffix: string) => ({
      claimCount,
      durationMs: 20,
      hash: suffix.repeat(64),
      operationId: `operation-${role}-0001`,
      providerRequestId: `provider-${role}`,
      role,
      usage
    });
    const result = groundSettledKnowledgeAnswerV12({
      contracts: { draftContractVersion: 16, selectorContractVersion: 12 },
      draftClaimCount: 4,
      drafts: [operation("primary", 4, "a")],
      evidence: evidence(),
      evidenceReceiptHash: "c".repeat(64),
      selectors: [operation("initial", null, "d")],
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Supported quantitative comparison. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 1,
        unsupportedClaimCount: 0
      }
    });

    expect(result).toMatchObject({
      adaptiveCorrectionApplied: false,
      correctionCompleted: false,
      draftContractVersion: 16,
      selectorContractVersion: 12,
      selectorValidationRepairApplied: false,
      selectorValidationRepairCompleted: false,
      version: 12
    });
    expect(JSON.stringify(result)).not.toContain("Evidence");
  });

  it("records V17/V13 normalized-selector operations in content-free Grounding Evidence V13", () => {
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12
    };
    const operation = (role: "initial" | "primary", claimCount: number | null, suffix: string) => ({
      claimCount,
      durationMs: 20,
      hash: suffix.repeat(64),
      operationId: `operation-${role}-0001`,
      providerRequestId: `provider-${role}`,
      role,
      usage
    });
    const result = groundSettledKnowledgeAnswerV13({
      contracts: { draftContractVersion: 17, selectorContractVersion: 13 },
      draftClaimCount: 1,
      drafts: [operation("primary", 1, "a")],
      evidence: evidence(),
      evidenceReceiptHash: "c".repeat(64),
      selectors: [operation("initial", null, "d")],
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Supported polar relation. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 1,
        unsupportedClaimCount: 0
      }
    });

    expect(result).toMatchObject({
      adaptiveCorrectionApplied: false,
      correctionCompleted: false,
      draftContractVersion: 17,
      selectorContractVersion: 13,
      selectorValidationRepairApplied: false,
      selectorValidationRepairCompleted: false,
      version: 13
    });
    expect(JSON.stringify(result)).not.toContain(privateSourceId);
  });

  it("records V18/V14 coverage-first operations in content-free Grounding Evidence V14", () => {
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12
    };
    const operation = (role: "initial" | "primary", claimCount: number | null, suffix: string) => ({
      claimCount,
      durationMs: 20,
      hash: suffix.repeat(64),
      operationId: `operation-${role}-0001`,
      providerRequestId: `provider-${role}`,
      role,
      usage
    });
    const result = groundSettledKnowledgeAnswerV14({
      contracts: { draftContractVersion: 18, selectorContractVersion: 14 },
      draftClaimCount: 2,
      drafts: [operation("primary", 2, "a")],
      evidence: evidence(),
      evidenceReceiptHash: "c".repeat(64),
      selectors: [operation("initial", null, "d")],
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Supported co-equal results. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 2,
        unsupportedClaimCount: 0
      }
    });

    expect(result).toMatchObject({
      adaptiveCorrectionApplied: false,
      correctionCompleted: false,
      draftContractVersion: 18,
      selectorContractVersion: 14,
      selectorValidationRepairApplied: false,
      selectorValidationRepairCompleted: false,
      version: 14
    });
    expect(JSON.stringify(result)).not.toContain(privateSourceId);
  });

  it("records V19/V15 phased coverage operations in content-free Grounding Evidence V15", () => {
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12
    };
    const operation = (role: "initial" | "primary", claimCount: number | null, suffix: string) => ({
      claimCount,
      durationMs: 20,
      hash: suffix.repeat(64),
      operationId: `operation-${role}-0001`,
      providerRequestId: `provider-${role}`,
      role,
      usage
    });
    const result = groundSettledKnowledgeAnswerV15({
      contracts: { draftContractVersion: 19, selectorContractVersion: 15 },
      draftClaimCount: 2,
      drafts: [operation("primary", 2, "a")],
      evidence: evidence(),
      evidenceReceiptHash: "c".repeat(64),
      selectors: [operation("initial", null, "d")],
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Supported phased results. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 2,
        unsupportedClaimCount: 0
      }
    });

    expect(result).toMatchObject({
      adaptiveCorrectionApplied: false,
      correctionCompleted: false,
      draftContractVersion: 19,
      selectorContractVersion: 15,
      selectorValidationRepairApplied: false,
      selectorValidationRepairCompleted: false,
      version: 15
    });
    expect(JSON.stringify(result)).not.toContain(privateSourceId);
  });

  it("records the Planner before V20/V16 in content-free Grounding Evidence V16", () => {
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12
    };
    const operation = (
      role: "initial" | "planner" | "primary",
      claimCount: number | null,
      suffix: string
    ) => ({
      claimCount,
      durationMs: 20,
      hash: suffix.repeat(64),
      operationId: `operation-${role}-0001`,
      providerRequestId: `provider-${role}`,
      role,
      usage
    });
    const result = groundSettledKnowledgeAnswerV16({
      contracts: { draftContractVersion: 20, selectorContractVersion: 16 },
      coveragePlanner: operation("planner", null, "e"),
      draftClaimCount: 2,
      drafts: [operation("primary", 2, "a")],
      evidence: evidence(),
      evidenceReceiptHash: "c".repeat(64),
      selectors: [operation("initial", null, "d")],
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Supported planned results. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 2,
        unsupportedClaimCount: 0
      }
    });

    expect(result).toMatchObject({
      adaptiveCorrectionApplied: false,
      correctionCompleted: false,
      coveragePlanner: { claimCount: null, role: "planner" },
      draftContractVersion: 20,
      selectorContractVersion: 16,
      selectorValidationRepairApplied: false,
      selectorValidationRepairCompleted: false,
      version: 16
    });
    expect(JSON.stringify(result)).not.toContain(privateSourceId);
    expect(JSON.stringify(result)).not.toContain("requested alpha value");
  });

  it("records the audited V21 protocol in content-free Grounding Evidence V17", () => {
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12
    };
    const auditPayloadHash = "f".repeat(64);
    const result = groundSettledKnowledgeAnswerV17({
      audit: {
        coveredDimensionCount: 1,
        dimensionCount: 1,
        missingDimensionCount: 0,
        payloadHash: auditPayloadHash
      },
      contracts: {
        coverageAuditorContractVersion: 1,
        draftContractVersion: 21,
        selectorContractVersion: 17,
        settlementVersion: 6
      },
      evidence: evidence(),
      evidenceReceiptHash: "1".repeat(64),
      modelPinFingerprint: "2".repeat(64),
      operations: [{
        acceptedRequestHash: "3".repeat(64),
        acceptedResultHash: "4".repeat(64),
        contractVersion: 21,
        durationMs: 20,
        operationId: "operation-primary-v21",
        ordinal: 1,
        providerRequestId: "provider-primary-v21",
        purpose: "knowledge_answer_draft_v21",
        role: "primary",
        usage
      }, {
        acceptedRequestHash: "5".repeat(64),
        acceptedResultHash: "6".repeat(64),
        contractVersion: 17,
        durationMs: 18,
        operationId: "operation-initial-v17",
        ordinal: 2,
        providerRequestId: "provider-initial-v17",
        purpose: "knowledge_grounded_selector_v17",
        role: "initial",
        usage
      }, {
        acceptedRequestHash: "7".repeat(64),
        acceptedResultHash: "9".repeat(64),
        contractVersion: 1,
        durationMs: 16,
        operationId: "operation-auditor-v1",
        ordinal: 3,
        providerRequestId: "provider-auditor-v1",
        purpose: "knowledge_coverage_auditor_v1",
        role: "auditor",
        usage
      }, {
        acceptedRequestHash: "a".repeat(64),
        acceptedResultHash: auditPayloadHash,
        contractVersion: 1,
        durationMs: 14,
        operationId: "operation-auditor-repair-v1",
        ordinal: 4,
        providerRequestId: "provider-auditor-repair-v1",
        purpose: "knowledge_coverage_auditor_v1",
        role: "auditor_repair",
        usage
      }],
      providerPinFingerprint: "8".repeat(64),
      selectorRepairSucceeded: false,
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Supported audited result. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 1,
        unsupportedClaimCount: 0
      }
    });

    expect(result).toMatchObject({
      audit: { dimensionCount: 1, payloadHash: auditPayloadHash, status: "accepted" },
      contracts: {
        coverageAuditorContractVersion: 1,
        draftContractVersion: 21,
        selectorContractVersion: 17,
        settlementVersion: 6
      },
      correctionAttempted: false,
      correctionSucceeded: false,
      selectorRepairAttempted: false,
      selectorRepairSucceeded: false,
      version: 17
    });
    expect(result.operations.map(({ role }) => role)).toEqual([
      "primary",
      "initial",
      "auditor",
      "auditor_repair"
    ]);
    expect(JSON.stringify(result.operations)).not.toContain("Supported audited result");
    expect(JSON.stringify(result)).not.toContain(privateSourceId);
  });

  it("allows one accepted V21 correction to advance audited partial coverage to complete", () => {
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12
    };
    const auditPayloadHash = "a".repeat(64);
    const operation = (
      acceptedRequestHash: string,
      acceptedResultHash: string,
      contractVersion: 1 | 17 | 21,
      ordinal: 1 | 2 | 3 | 4 | 5,
      purpose:
        | "knowledge_answer_draft_supplement_v21"
        | "knowledge_answer_draft_v21"
        | "knowledge_coverage_auditor_v1"
        | "knowledge_grounded_selector_final_v17"
        | "knowledge_grounded_selector_v17",
      role: "auditor" | "final" | "initial" | "primary" | "supplement"
    ) => ({
      acceptedRequestHash,
      acceptedResultHash,
      contractVersion,
      durationMs: 10,
      operationId: `operation-${role}-v21`,
      ordinal,
      providerRequestId: `provider-${role}-v21`,
      purpose,
      role,
      usage
    });
    const result = groundSettledKnowledgeAnswerV17({
      audit: {
        coveredDimensionCount: 1,
        dimensionCount: 2,
        missingDimensionCount: 1,
        payloadHash: auditPayloadHash
      },
      contracts: {
        coverageAuditorContractVersion: 1,
        draftContractVersion: 21,
        selectorContractVersion: 17,
        settlementVersion: 6
      },
      evidence: evidence(),
      evidenceReceiptHash: "b".repeat(64),
      modelPinFingerprint: "c".repeat(64),
      operations: [
        operation(
          "1".repeat(64),
          "2".repeat(64),
          21,
          1,
          "knowledge_answer_draft_v21",
          "primary"
        ),
        operation(
          "3".repeat(64),
          "4".repeat(64),
          17,
          2,
          "knowledge_grounded_selector_v17",
          "initial"
        ),
        operation(
          "5".repeat(64),
          auditPayloadHash,
          1,
          3,
          "knowledge_coverage_auditor_v1",
          "auditor"
        ),
        operation(
          "6".repeat(64),
          "7".repeat(64),
          21,
          4,
          "knowledge_answer_draft_supplement_v21",
          "supplement"
        ),
        operation(
          "8".repeat(64),
          "9".repeat(64),
          17,
          5,
          "knowledge_grounded_selector_final_v17",
          "final"
        )
      ],
      providerPinFingerprint: "d".repeat(64),
      selectorRepairSucceeded: false,
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Both corrected dimensions are supported. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 2,
        unsupportedClaimCount: 0
      }
    });

    expect(result).toMatchObject({
      audit: { missingDimensionCount: 1 },
      correctionAttempted: true,
      correctionSucceeded: true,
      requestCoverage: "complete",
      version: 17
    });
  });

  it("accepts ANSWERED only with a dispatched citation", () => {
    const result = groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nОтвет подтвержден [K1].",
      evidence: evidence()
    });
    expect(result).toMatchObject({ outcome: "answered", finalText: "Ответ подтвержден [K1]." });
  });

  it("normalizes grouped citation syntax without rewriting prose", () => {
    const result = groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nAnswer 【K1】.",
      evidence: evidence()
    });
    expect(result.finalText).toBe("Answer [K1].");
  });

  it("normalizes the provider-native wrapped citation syntax", () => {
    const result = groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nОтвет citeK1.",
      evidence: evidence()
    });
    expect(result.finalText).toBe("Ответ [K1].");
  });

  it("normalizes unambiguous provider wrapper separator variants", () => {
    const current = toolLoopEvidence();
    for (const wrapper of [
      "citeK1, K2",
      "citeK1; K2",
      "cite[K1] and 【K2】",
      "citeK1 K2"
    ]) {
      expect(groundKnowledgeAnswer({
        answer: `AIQSA_KB_STATUS=ANSWERED\nSupported ${wrapper}.`,
        evidence: current
      }).finalText).toBe("Supported [K1][K2].");
    }
  });

  it("fails closed for malformed or unknown provider-native citation wrappers", () => {
    for (const answer of [
      "Ответ citeK2.",
      "Ответ citeK1.",
      "Ответ citeK1-K2.",
      "Ответ citeK1 unsupported K2."
    ]) {
      expect(() => groundKnowledgeAnswer({
        answer: `AIQSA_KB_STATUS=ANSWERED\n${answer}`,
        evidence: evidence()
      })).toThrow(KnowledgeAnswerContractError);
    }
  });

  it("canonicalizes lowercase handles while preserving Markdown whitespace", () => {
    const result = groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\n    code block [k1]\n",
      evidence: evidence()
    });
    expect(result.finalText).toBe("    code block [K1]\n");
  });

  it("requires the exact unpadded first-line status", () => {
    expect(() => groundKnowledgeAnswer({
      answer: " AIQSA_KB_STATUS=ANSWERED\nAnswer [K1].",
      evidence: evidence()
    })).toThrow(KnowledgeAnswerContractError);
    expect(() => groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED \nAnswer [K1].",
      evidence: evidence()
    })).toThrow(KnowledgeAnswerContractError);
  });

  it("rejects ANSWERED without a citation", () => {
    expect(() => groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nОтвет без ссылки.",
      evidence: evidence()
    })).toThrow(KnowledgeAnswerContractError);
  });

  it("accepts INSUFFICIENT_EVIDENCE without semantic phrase matching", () => {
    expect(groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=INSUFFICIENT_EVIDENCE\nНедостаточно данных.",
      evidence: evidence()
    }).outcome).toBe("insufficient_evidence");
  });

  it("rejects unknown handles", () => {
    expect(() => groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nClaim [K2].",
      evidence: evidence()
    })).toThrow("outside the final evidence manifest");
  });

  it.each([
    "evidence-1",
    "source-1",
    privateSourceId,
    "version-1",
    "artifact-1",
    "passage-1",
    "a".repeat(64)
  ])("rejects the internal Knowledge identity value %s", (identity) => {
    expect(() => groundKnowledgeAnswer({
      answer: `AIQSA_KB_STATUS=INSUFFICIENT_EVIDENCE\nInternal record: ${identity}`,
      evidence: evidence()
    })).toThrow("internal identity");
  });

  it("allows technical field names without exposing concrete private values", () => {
    const body = "The sourceId, documentId, contentHash, and confidenceScore fields are documented.";
    expect(groundKnowledgeAnswer({
      answer: `AIQSA_KB_STATUS=INSUFFICIENT_EVIDENCE\n${body}`,
      evidence: evidence()
    }).finalText).toBe(body);
  });

  it("does not reject ordinary prose that describes identifiers or scoring generically", () => {
    expect(groundKnowledgeAnswer({
      answer: [
        "AIQSA_KB_STATUS=INSUFFICIENT_EVIDENCE",
        "The source identifier and ranking method are not available in the supplied evidence."
      ].join("\n"),
      evidence: evidence()
    }).outcome).toBe("insufficient_evidence");
  });
});

describe("Knowledge tool-loop citation contract", () => {
  it("keeps ordinary Markdown and permits an answer without a Knowledge citation", () => {
    const answer = "## Result\n\nNo selected Knowledge passage was needed; see [web](https://example.test).";
    expect(groundKnowledgeToolLoopAnswer({
      answer,
      evidence: toolLoopEvidence()
    })).toMatchObject({ finalText: answer, outcome: "answered" });
  });

  it.each([
    "[Knowledge Base](https://example.test/knowledge)",
    "[Kubernetes docs](https://example.test/kubernetes)",
    "[K8s docs](https://example.test/k8s)",
    "[Key findings]"
  ])("keeps non-citation Markdown beginning with K: %s", (answer) => {
    expect(groundKnowledgeToolLoopAnswer({
      answer,
      evidence: toolLoopEvidence()
    }).finalText).toBe(answer);
  });

  it.each([
    "Vitamin K2 is discussed in the source.",
    "A K1 visa is a distinct term.",
    "Form K1 is available online.",
    "Bare K999 is not citation syntax."
  ])("keeps a bare K-number term as ordinary prose: %s", (answer) => {
    expect(groundKnowledgeToolLoopAnswer({
      answer,
      evidence: toolLoopEvidence()
    }).finalText).toBe(answer);
  });

  it("allows field terminology but rejects concrete private UUIDs and hashes", () => {
    const current = toolLoopEvidence();
    const safeAnswer = "The sourceId field contains an identifier.";
    expect(groundKnowledgeToolLoopAnswer({
      answer: safeAnswer,
      evidence: current
    }).finalText).toBe(safeAnswer);

    for (const identity of [privateSourceId, "a".repeat(64)]) {
      expect(() => groundKnowledgeToolLoopAnswer({
        answer: `Internal record: ${identity}`,
        evidence: current
      })).toThrow("internal Knowledge identity");
    }
  });

  it("accepts mixed Knowledge and Web citations", () => {
    const answer = "The policy says 30 days [K1], while the current web page says 45 days [W1].";
    expect(groundKnowledgeToolLoopAnswer({
      answer,
      evidence: toolLoopEvidence()
    }).finalText).toBe(answer);
  });

  it("narrowly normalizes a comma group only when every handle is valid", () => {
    expect(groundKnowledgeToolLoopAnswer({
      answer: "Supported by both passages [K1, K2].",
      evidence: toolLoopEvidence()
    }).finalText).toBe("Supported by both passages [K1][K2].");
    expect(() => groundKnowledgeToolLoopAnswer({
      answer: "Unsupported group [K1, K3].",
      evidence: toolLoopEvidence()
    })).toThrow(KnowledgeAnswerContractError);
  });

  it("normalizes provider full-width citation brackets in an ordinary tool-loop answer", () => {
    expect(groundKnowledgeToolLoopAnswer({
      answer: "Подтверждено 【K2】【K1】.",
      evidence: toolLoopEvidence()
    }).finalText).toBe("Подтверждено [K2][K1].");
  });

  it("normalizes a multi-handle provider-native wrapper", () => {
    expect(groundKnowledgeToolLoopAnswer({
      answer: "Supported citeK2K1.",
      evidence: toolLoopEvidence()
    }).finalText).toBe("Supported [K2][K1].");
  });

  it("rejects unknown, deleted, non-dispatched, and malformed handles", () => {
    const current = toolLoopEvidence();
    const deleted: KnowledgeEvidencePackage = {
      ...current,
      items: current.items.map((item, index) => index === 0
        ? { ...item, state: "deleted" as const }
        : item)
    };
    for (const [answer, selectedEvidence] of [
      ["Unknown [K999].", toolLoopEvidence()],
      ["Deleted [K1].", deleted],
      ["Malformed [K0].", toolLoopEvidence()],
      ["Malformed [K01].", toolLoopEvidence()],
      ["Malformed [K1 and K2].", toolLoopEvidence()],
      ["Malformed 【K0】.", toolLoopEvidence()]
    ] as const) {
      expect(() => groundKnowledgeToolLoopAnswer({
        answer,
        evidence: selectedEvidence
      })).toThrow(KnowledgeAnswerContractError);
    }
  });
});
