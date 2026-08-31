import { describe, expect, it } from "vitest";
import type {
  KnowledgeGroundingEvidenceV18,
  KnowledgeGroundingEvidenceV19,
  KnowledgeGroundingEvidenceV21,
  KnowledgeGroundingEvidenceV22
} from "./grounding";
import {
  aggregateKnowledgeGroundingMetrics,
  loadKnowledgeGroundingOperationalMetrics
} from "./groundingMetrics";

const hash = "a".repeat(64);

function evidence(durationMs: number): KnowledgeGroundingEvidenceV18 {
  const operation = (
    role: "auditor" | "initial" | "primary",
    ordinal: 1 | 2 | 3,
    inputTokens: number,
    outputTokens: number
  ) => ({
    acceptedRequestHash: hash,
    acceptedResultHash: hash,
    contractVersion: role === "primary" ? 21 : role === "auditor" ? 1 : 17,
    durationMs,
    operationId: `operation-${role}`,
    ordinal,
    providerRequestId: null,
    purpose: role === "primary"
      ? "knowledge_answer_draft_v21"
      : role === "auditor"
        ? "knowledge_coverage_auditor_v2"
        : "knowledge_grounded_selector_v17",
    role,
    usage: {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: inputTokens + outputTokens
    }
  });
  return {
    answerBindingFingerprint: hash,
    audit: {
      coveredDimensionCount: 1,
      dimensionCount: 2,
      missingDimensionCount: 1,
      payloadHash: hash,
      status: "accepted"
    },
    contracts: {
      coverageAuditorContractVersion: 2,
      draftContractVersion: 21,
      selectorContractVersion: 17,
      settlementVersion: 6
    },
    correctionAttempted: true,
    correctionSucceeded: false,
    contradictedClaimCount: 1,
    draftClaimCount: 4,
    evidenceReceiptHash: hash,
    executionPolicy: {
      auditorReasoningEffort: "high",
      draftReasoningEffort: "low",
      egressDestination: "answer_provider",
      overriddenRoles: ["auditor"],
      providerBindingKey: "answer",
      selectorReasoningEffort: "low",
      supplementReasoningEffort: "low",
      version: 1
    },
    executionPolicyFingerprint: hash,
    fallbackReason: null,
    finalAnswerHash: hash,
    finalText: "PRIVATE CLAIM TEXT",
    finalizationMode: "selected_claims",
    groundingStatus: "verified",
    modelPinFingerprint: hash,
    operations: [
      operation("primary", 1, 100, 10),
      operation("initial", 2, 80, 8),
      operation("auditor", 3, 60, 6)
    ],
    originalAnswerHash: hash,
    outcome: "answered",
    providerPinFingerprint: hash,
    receiptHash: hash,
    requestCoverage: "partial",
    selectorRepairAttempted: false,
    selectorRepairSucceeded: false,
    sessionId: "PRIVATE-SOURCE-ID",
    supportedClaimCount: 2,
    unsupportedClaimCount: 1,
    version: 18
  } as unknown as KnowledgeGroundingEvidenceV18;
}

function evidenceV19(durationMs: number): KnowledgeGroundingEvidenceV19 {
  const historical = evidence(durationMs);
  return {
    ...historical,
    contracts: {
      coverageAuditorContractVersion: 3,
      draftContractVersion: 21,
      selectorContractVersion: 18,
      settlementVersion: 6
    },
    coverage: {
      coveredDimensionCount: 1,
      missingDimensionCount: 1,
      selectorPayloadHash: hash,
      status: "accepted"
    },
    coverageScope: {
      dimensionCount: 2,
      payloadHash: hash,
      status: "accepted"
    },
    operations: historical.operations.map((operation) => operation.role === "auditor"
      ? {
          ...operation,
          contractVersion: 3,
          purpose: "knowledge_coverage_scope_v3",
          role: "scope" as const
        }
      : operation.role === "initial"
        ? {
            ...operation,
            contractVersion: 18,
            purpose: "knowledge_grounded_selector_v18"
          }
        : operation),
    scopeRepairAttempted: false,
    scopeRepairSucceeded: false,
    version: 19
  } as unknown as KnowledgeGroundingEvidenceV19;
}

function evidenceV21(durationMs: number): KnowledgeGroundingEvidenceV21 {
  const historical = evidenceV19(durationMs);
  return {
    ...historical,
    contracts: {
      coverageAuditorContractVersion: 5,
      draftContractVersion: 21,
      selectorContractVersion: 20,
      settlementVersion: 6
    },
    operations: historical.operations.map((operation) => operation.role === "scope"
      ? {
          ...operation,
          contractVersion: 5,
          purpose: "knowledge_coverage_scope_v5"
        }
      : operation.role === "initial"
        ? {
            ...operation,
            contractVersion: 20,
            purpose: "knowledge_grounded_selector_v20"
          }
        : operation),
    version: 21
  } as unknown as KnowledgeGroundingEvidenceV21;
}

function evidenceV22(durationMs: number): KnowledgeGroundingEvidenceV22 {
  const historical = evidenceV21(durationMs);
  return {
    ...historical,
    contracts: {
      coverageAuditorContractVersion: 6,
      draftContractVersion: 21,
      selectorContractVersion: 21,
      settlementVersion: 6
    },
    operations: historical.operations.map((operation) => operation.role === "scope"
      ? {
          ...operation,
          contractVersion: 6,
          purpose: "knowledge_coverage_scope_v6"
        }
      : operation.role === "initial"
        ? {
            ...operation,
            contractVersion: 21,
            purpose: "knowledge_grounded_selector_v21"
          }
        : operation),
    version: 22
  } as unknown as KnowledgeGroundingEvidenceV22;
}

describe("Knowledge grounding operational metrics", () => {
  it("aggregates stage histograms, usage, verdicts, audit, and correction counts", () => {
    const metrics = aggregateKnowledgeGroundingMetrics([
      evidence(100),
      evidenceV19(300)
    ]);
    expect(metrics).toMatchObject({
      answers: 2,
      auditAccepted: 1,
      correctionAttempted: 2,
      correctionSucceeded: 0,
      coverageScopeAccepted: 1,
      draftClaims: 8,
      modelOperations: 6,
      pipelineVersion21: 2,
      selectorContradicted: 2,
      selectorSupported: 4,
      selectorUnsupported: 2,
      totalCoverageDimensions: 4,
      totalMissingCoverageDimensions: 2
    });
    expect(metrics.stages.auditor.calls).toBe(1);
    expect(metrics.stages.scope.calls).toBe(1);
    expect(metrics.coverage).toEqual({ complete: 0, none: 0, partial: 2 });
    expect(metrics.stages.primary).toEqual({
      calls: 2,
      p50DurationMs: 100,
      p95DurationMs: 300,
      totalDurationMs: 400,
      totalInputTokens: 200,
      totalOutputTokens: 20
    });
    expect(metrics.stages.repair.calls).toBe(0);
    expect(metrics.stages.auditor_repair.calls).toBe(0);
  });

  it("projects no request, evidence, claim, or private identity text", () => {
    const serialized = JSON.stringify(aggregateKnowledgeGroundingMetrics([evidence(100)]));
    expect(serialized).not.toContain("PRIVATE CLAIM TEXT");
    expect(serialized).not.toContain("PRIVATE-SOURCE-ID");
    expect(serialized).not.toContain(hash);
  });

  it("loads only structurally valid V18-V22 metric receipts", async () => {
    const findMany = async (query: unknown) => {
      expect(query).toMatchObject({
        where: { version: { in: [18, 19, 20, 21, 22] } }
      });
      return [
        { evidence: evidence(100) },
        { evidence: evidenceV19(100) },
        { evidence: evidenceV21(100) },
        { evidence: evidenceV22(100) },
        { evidence: { finalText: "PRIVATE", operations: [], version: 18 } }
      ];
    };
    const metrics = await loadKnowledgeGroundingOperationalMetrics({
      knowledgeGroundingResult: { findMany }
    } as never, { limit: 5 });
    expect(metrics.answers).toBe(4);
    expect(metrics.modelOperations).toBe(12);
  });
});
