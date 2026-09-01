import { describe, expect, it } from "vitest";
import type {
  KnowledgeGroundingEvidenceV18,
  KnowledgeGroundingEvidenceV19,
  KnowledgeGroundingEvidenceV21,
  KnowledgeGroundingEvidenceV22,
  KnowledgeGroundingEvidenceV23,
  KnowledgeGroundingEvidenceV24,
  KnowledgeGroundingEvidenceV25,
  KnowledgeGroundingEvidenceV26,
  KnowledgeGroundingEvidenceV27,
  KnowledgeGroundingEvidenceV28,
  KnowledgeGroundingEvidenceV29,
  KnowledgeGroundingEvidenceV30,
  KnowledgeGroundingEvidenceV31,
  KnowledgeGroundingEvidenceV32,
  KnowledgeGroundingEvidenceV33,
  KnowledgeGroundingEvidenceV34,
  KnowledgeGroundingEvidenceV35,
  KnowledgeGroundingEvidenceV36,
  KnowledgeGroundingEvidenceV37,
  KnowledgeGroundingEvidenceV38,
  KnowledgeGroundingEvidenceV39,
  KnowledgeGroundingEvidenceV40,
  KnowledgeGroundingEvidenceV41,
  KnowledgeGroundingEvidenceV42,
  KnowledgeGroundingEvidenceV43,
  KnowledgeGroundingEvidenceV44,
  KnowledgeGroundingEvidenceV45,
  KnowledgeGroundingEvidenceV46,
  KnowledgeGroundingEvidenceV47,
  KnowledgeGroundingEvidenceV48,
  KnowledgeGroundingEvidenceV49,
  KnowledgeGroundingEvidenceV50,
  KnowledgeGroundingEvidenceV51,
  KnowledgeGroundingEvidenceV52,
  KnowledgeGroundingEvidenceV53,
  KnowledgeGroundingEvidenceV54
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

function evidenceV23(durationMs: number): KnowledgeGroundingEvidenceV23 {
  const historical = evidenceV22(durationMs);
  return {
    ...historical,
    coverage: {
      ...historical.coverage,
      excludedDimensionCount: 1
    },
    coverageScope: {
      ...historical.coverageScope,
      dimensionCount: 3
    },
    version: 23
  } as unknown as KnowledgeGroundingEvidenceV23;
}

function evidenceV24(durationMs: number): KnowledgeGroundingEvidenceV24 {
  const historical = evidenceV23(durationMs);
  const [primary, scope, initial] = historical.operations;
  return {
    ...historical,
    completeness: {
      addedDimensionCount: 2,
      initialDimensionCount: 1,
      initialScopePayloadHash: hash,
      payloadHash: hash,
      status: "accepted"
    },
    completenessRepairAttempted: false,
    completenessRepairSucceeded: false,
    operations: [primary, scope, {
      ...scope,
      contractVersion: 1,
      operationId: "operation-scope-completeness",
      ordinal: 3,
      purpose: "knowledge_coverage_scope_completeness_v1",
      role: "scope_completeness"
    }, { ...initial, ordinal: 4 }],
    version: 24
  } as unknown as KnowledgeGroundingEvidenceV24;
}

function evidenceV25(durationMs: number): KnowledgeGroundingEvidenceV25 {
  const historical = evidenceV24(durationMs);
  const [primary, scope, completeness, initial] = historical.operations;
  return {
    ...historical,
    completenessRepairAttempted: false,
    completenessRepairSucceeded: false,
    correctionAttempted: true,
    correctionSucceeded: true,
    operations: [primary, scope, {
      ...scope,
      operationId: "operation-scope-repair",
      ordinal: 3,
      role: "scope_repair"
    }, { ...completeness, ordinal: 4 }, { ...initial, ordinal: 5 }, {
      ...primary,
      operationId: "operation-supplement",
      ordinal: 6,
      role: "supplement"
    }, {
      ...initial,
      operationId: "operation-final",
      ordinal: 7,
      role: "final"
    }],
    scopeRepairAttempted: true,
    scopeRepairSucceeded: true,
    version: 25
  } as unknown as KnowledgeGroundingEvidenceV25;
}

function evidenceV26(durationMs: number): KnowledgeGroundingEvidenceV26 {
  return {
    ...evidenceV25(durationMs),
    version: 26
  } as KnowledgeGroundingEvidenceV26;
}

function evidenceV27(durationMs: number): KnowledgeGroundingEvidenceV27 {
  return {
    ...evidenceV26(durationMs),
    version: 27
  } as KnowledgeGroundingEvidenceV27;
}

function evidenceV28(durationMs: number): KnowledgeGroundingEvidenceV28 {
  return {
    ...evidenceV27(durationMs),
    version: 28
  } as KnowledgeGroundingEvidenceV28;
}

function evidenceV29(durationMs: number): KnowledgeGroundingEvidenceV29 {
  return {
    ...evidenceV28(durationMs),
    version: 29
  } as KnowledgeGroundingEvidenceV29;
}

function evidenceV30(durationMs: number): KnowledgeGroundingEvidenceV30 {
  return {
    ...evidenceV29(durationMs),
    version: 30
  } as KnowledgeGroundingEvidenceV30;
}

function evidenceV31(durationMs: number): KnowledgeGroundingEvidenceV31 {
  return {
    ...evidenceV30(durationMs),
    version: 31
  } as KnowledgeGroundingEvidenceV31;
}

function evidenceV32(durationMs: number): KnowledgeGroundingEvidenceV32 {
  return {
    ...evidenceV31(durationMs),
    version: 32
  } as KnowledgeGroundingEvidenceV32;
}

function evidenceV33(durationMs: number): KnowledgeGroundingEvidenceV33 {
  return {
    ...evidenceV32(durationMs),
    version: 33
  } as KnowledgeGroundingEvidenceV33;
}

function evidenceV34(durationMs: number): KnowledgeGroundingEvidenceV34 {
  const historical = evidenceV33(durationMs);
  const [primary, scope, _scopeRepair, completeness, initial, supplement, final] =
    historical.operations;
  void _scopeRepair;
  return {
    ...historical,
    closure: {
      initialCoveredDimensionCount: 2,
      payloadHash: hash,
      reopenedDimensionCount: 1,
      status: "accepted"
    },
    closureRepairAttempted: false,
    closureRepairSucceeded: false,
    operations: [primary, scope, { ...completeness, ordinal: 3 }, {
      ...initial,
      ordinal: 4
    }, {
      ...initial,
      contractVersion: 1,
      operationId: "operation-scope-closure",
      ordinal: 5,
      purpose: "knowledge_coverage_scope_closure_v1",
      role: "scope_closure"
    }, supplement, final],
    version: 34
  } as KnowledgeGroundingEvidenceV34;
}

function evidenceV35(durationMs: number): KnowledgeGroundingEvidenceV35 {
  const historical = evidenceV34(durationMs);
  const [primary, scope, completeness, initial, closure, supplement, final] =
    historical.operations;
  return {
    ...historical,
    operations: [primary, scope, {
      ...scope,
      operationId: "operation-scope-repair-v35",
      ordinal: 3,
      role: "scope_repair"
    }, { ...completeness, ordinal: 4 }, { ...initial, ordinal: 5 }, {
      ...closure,
      ordinal: 6
    }, { ...supplement, ordinal: 7 }, { ...final, ordinal: 8 }],
    scopeRepairAttempted: true,
    scopeRepairSucceeded: true,
    version: 35
  } as KnowledgeGroundingEvidenceV35;
}

function evidenceV36(durationMs: number): KnowledgeGroundingEvidenceV36 {
  return {
    ...evidenceV35(durationMs),
    version: 36
  } as KnowledgeGroundingEvidenceV36;
}

function evidenceV37(durationMs: number): KnowledgeGroundingEvidenceV37 {
  return {
    ...evidenceV36(durationMs),
    version: 37
  } as KnowledgeGroundingEvidenceV37;
}

function evidenceV38(durationMs: number): KnowledgeGroundingEvidenceV38 {
  return {
    ...evidenceV37(durationMs),
    version: 38
  } as KnowledgeGroundingEvidenceV38;
}

function evidenceV39(durationMs: number): KnowledgeGroundingEvidenceV39 {
  const historical = evidenceV34(durationMs);
  const final = historical.operations.at(-1)!;
  return {
    ...historical,
    operations: [...historical.operations, {
      ...final,
      operationId: "operation-final-delta-repair",
      ordinal: 8
    }],
    version: 39
  } as KnowledgeGroundingEvidenceV39;
}

function evidenceV40(durationMs: number): KnowledgeGroundingEvidenceV40 {
  return {
    ...evidenceV39(durationMs),
    version: 40
  } as KnowledgeGroundingEvidenceV40;
}

function evidenceV41(durationMs: number): KnowledgeGroundingEvidenceV41 {
  return {
    ...evidenceV40(durationMs),
    version: 41
  } as KnowledgeGroundingEvidenceV41;
}

function evidenceV42(durationMs: number): KnowledgeGroundingEvidenceV42 {
  return {
    ...evidenceV41(durationMs),
    version: 42
  } as KnowledgeGroundingEvidenceV42;
}

function evidenceV43(durationMs: number): KnowledgeGroundingEvidenceV43 {
  return {
    ...evidenceV42(durationMs),
    version: 43
  } as KnowledgeGroundingEvidenceV43;
}

function evidenceV44(durationMs: number): KnowledgeGroundingEvidenceV44 {
  return {
    ...evidenceV43(durationMs),
    version: 44
  } as KnowledgeGroundingEvidenceV44;
}

function evidenceV45(durationMs: number): KnowledgeGroundingEvidenceV45 {
  return {
    ...evidenceV44(durationMs),
    version: 45
  } as KnowledgeGroundingEvidenceV45;
}

function evidenceV46(durationMs: number): KnowledgeGroundingEvidenceV46 {
  return {
    ...evidenceV45(durationMs),
    version: 46
  } as KnowledgeGroundingEvidenceV46;
}

function evidenceV47(durationMs: number): KnowledgeGroundingEvidenceV47 {
  return {
    ...evidenceV46(durationMs),
    version: 47
  } as KnowledgeGroundingEvidenceV47;
}

function evidenceV48(durationMs: number): KnowledgeGroundingEvidenceV48 {
  return {
    ...evidenceV47(durationMs),
    version: 48
  } as KnowledgeGroundingEvidenceV48;
}

function evidenceV49(durationMs: number): KnowledgeGroundingEvidenceV49 {
  return {
    ...evidenceV48(durationMs),
    version: 49
  } as KnowledgeGroundingEvidenceV49;
}

function evidenceV50(durationMs: number): KnowledgeGroundingEvidenceV50 {
  return {
    ...evidenceV49(durationMs),
    version: 50
  } as KnowledgeGroundingEvidenceV50;
}

function evidenceV51(durationMs: number): KnowledgeGroundingEvidenceV51 {
  return {
    ...evidenceV50(durationMs),
    version: 51
  } as KnowledgeGroundingEvidenceV51;
}

function evidenceV52(durationMs: number): KnowledgeGroundingEvidenceV52 {
  const historical = evidenceV51(durationMs);
  return {
    ...historical,
    closure: {
      initialCoveredDimensionCount: 2,
      initialExcludedDimensionCount: 1,
      payloadHash: hash,
      reopenedCoveredDimensionCount: 1,
      reopenedDimensionCount: 1,
      reopenedExcludedDimensionCount: 0,
      status: "accepted"
    },
    operations: historical.operations.map((operation) =>
      operation.role === "scope_closure"
        ? {
            ...operation,
            contractVersion: 2,
            purpose: "knowledge_coverage_scope_closure_v2"
          }
        : operation),
    version: 52
  } as KnowledgeGroundingEvidenceV52;
}

function evidenceV53(durationMs: number): KnowledgeGroundingEvidenceV53 {
  return {
    ...evidenceV52(durationMs),
    closure: {
      initialCoveredDimensionCount: 0,
      initialExcludedDimensionCount: 1,
      payloadHash: hash,
      reopenedCoveredDimensionCount: 0,
      reopenedDimensionCount: 1,
      reopenedExcludedDimensionCount: 1,
      status: "accepted"
    },
    version: 53
  } as KnowledgeGroundingEvidenceV53;
}

function evidenceV54(durationMs: number): KnowledgeGroundingEvidenceV54 {
  return {
    ...evidenceV53(durationMs),
    crossTargetExactRepeatCount: 1,
    version: 54
  } as KnowledgeGroundingEvidenceV54;
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
      totalExcludedCoverageDimensions: 0,
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

  it("counts append-only Scope completeness without projecting its private additions", () => {
    const metrics = aggregateKnowledgeGroundingMetrics([
      evidenceV24(100),
      evidenceV25(100),
      evidenceV26(100),
      evidenceV27(100),
      evidenceV28(100),
      evidenceV29(100),
      evidenceV30(100),
      evidenceV31(100),
      evidenceV32(100),
      evidenceV33(100),
      evidenceV34(100),
      evidenceV35(100),
      evidenceV36(100),
      evidenceV37(100),
      evidenceV38(100),
      evidenceV39(100),
      evidenceV40(100),
      evidenceV41(100),
      evidenceV42(100),
      evidenceV43(100),
      evidenceV44(100),
      evidenceV45(100),
      evidenceV46(100),
      evidenceV47(100),
      evidenceV48(100),
      evidenceV49(100),
      evidenceV50(100),
      evidenceV51(100),
      evidenceV52(100),
      evidenceV53(100),
      evidenceV54(100)
    ]);
    expect(metrics.scopeCompletenessAccepted).toBe(31);
    expect(metrics.totalScopeCompletenessAdditions).toBe(62);
    expect(metrics.scopeClosureAccepted).toBe(21);
    expect(metrics.totalCrossTargetExactRepeatCount).toBe(1);
    expect(metrics.totalScopeClosureReopenedDimensions).toBe(21);
    expect(metrics.stages.scope_completeness.calls).toBe(31);
    expect(metrics.stages.scope_closure.calls).toBe(21);
    expect(metrics.stages.scope_repair.calls).toBe(13);
    expect(metrics.stages.final.calls).toBe(46);
    expect(JSON.stringify(metrics)).not.toContain("PRIVATE");
  });

  it("loads only structurally valid V18-V54 metric receipts", async () => {
    const findMany = async (query: unknown) => {
      expect(query).toMatchObject({
        where: {
          version: {
            in: [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
              34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
              50, 51, 52, 53, 54]
          }
        }
      });
      return [
        { evidence: evidence(100) },
        { evidence: evidenceV19(100) },
        { evidence: evidenceV21(100) },
        { evidence: evidenceV22(100) },
        { evidence: evidenceV23(100) },
        { evidence: evidenceV24(100) },
        { evidence: evidenceV25(100) },
        { evidence: evidenceV26(100) },
        { evidence: evidenceV27(100) },
        { evidence: evidenceV28(100) },
        { evidence: evidenceV29(100) },
        { evidence: evidenceV30(100) },
        { evidence: evidenceV31(100) },
        { evidence: evidenceV32(100) },
        { evidence: evidenceV33(100) },
        { evidence: evidenceV34(100) },
        { evidence: evidenceV35(100) },
        { evidence: evidenceV36(100) },
        { evidence: evidenceV37(100) },
        { evidence: evidenceV38(100) },
        { evidence: evidenceV39(100) },
        { evidence: evidenceV40(100) },
        { evidence: evidenceV41(100) },
        { evidence: evidenceV42(100) },
        { evidence: evidenceV43(100) },
        { evidence: evidenceV44(100) },
        { evidence: evidenceV45(100) },
        { evidence: evidenceV46(100) },
        { evidence: evidenceV47(100) },
        { evidence: evidenceV48(100) },
        { evidence: evidenceV49(100) },
        { evidence: evidenceV50(100) },
        { evidence: evidenceV51(100) },
        { evidence: evidenceV52(100) },
        { evidence: evidenceV53(100) },
        { evidence: evidenceV54(100) },
        { evidence: { ...evidenceV54(100), crossTargetExactRepeatCount: -1 } },
        { evidence: {
          ...evidenceV53(100),
          closure: {
            ...evidenceV53(100).closure,
            reopenedDimensionCount: 2
          }
        } },
        { evidence: { ...evidenceV35(100), version: 34 } },
        { evidence: { ...evidenceV25(100), version: 24 } },
        { evidence: { finalText: "PRIVATE", operations: [], version: 18 } }
      ];
    };
    const metrics = await loadKnowledgeGroundingOperationalMetrics({
      knowledgeGroundingResult: { findMany }
    } as never, { limit: 5 });
    expect(metrics.answers).toBe(36);
    expect(metrics.modelOperations).toBe(249);
    expect(metrics.totalCrossTargetExactRepeatCount).toBe(1);
  });
});
