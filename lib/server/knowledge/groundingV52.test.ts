import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
  KNOWLEDGE_ANSWER_V21_CONTRACT_VERSIONS
} from "./answerGroundingV21";
import { knowledgeAnswerHash } from "./answerGroundingV5";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
} from "./answerGroundingSelectorV21";
import { KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION } from "./coverageScopeV6";
import {
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
} from "./coverageScopeCompletenessV1";
import {
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_V2_OPERATION
} from "./coverageScopeClosureV2";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  type KnowledgeEvidencePackage
} from "./evidencePackage";
import {
  groundSettledKnowledgeAnswerV52,
  groundSettledKnowledgeAnswerV53,
  groundSettledKnowledgeAnswerV54,
  groundSettledKnowledgeAnswerV55,
  KnowledgeAnswerContractError
} from "./grounding";

const hash = "a".repeat(64);
const completenessHash = "b".repeat(64);
const selectorHash = "c".repeat(64);
const closureHash = "d".repeat(64);
const executionPolicy = Object.freeze({
  auditorReasoningEffort: "high",
  draftReasoningEffort: "low",
  egressDestination: "answer_provider",
  overriddenRoles: Object.freeze(["auditor"] as const),
  providerBindingKey: "answer",
  selectorReasoningEffort: "low",
  supplementReasoningEffort: "low",
  version: 1
} as const);
const usage = Object.freeze({
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  estimatedCostMicros: null,
  inputTokens: 10,
  outputTokens: 5,
  reasoningTokens: 0,
  totalTokens: 15
});

function evidence(): KnowledgeEvidencePackage {
  return {
    citationContract: KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
    coverage: {
      expectedPassageCount: null,
      mode: "partial",
      namedTargets: [],
      verified: false
    },
    degradedFlags: [],
    items: [{
      baseName: "Base",
      contentHash: hash,
      contextBoundaries: { expanded: false, excerptBytes: 8, sourceTextBytes: 8 },
      documentId: "document-1",
      documentVersionId: "document-version-1",
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
      sourceId: "source-1",
      sourceName: "Source",
      sourceVersionId: "source-version-1",
      sourceVersionNumber: 1,
      state: "available",
      textTruncated: false
    }],
    originalIntent: { kind: "focused_v1", query: "Question" },
    readiness: { excludedResources: 0, readyBases: 1, readySources: 1 },
    runId: "run-1",
    scopeSnapshot: {},
    sessionId: "session-1",
    version: 2
  };
}

function operation(
  role: "primary" | "scope" | "scope_completeness" | "initial" |
    "scope_closure" | "supplement" | "final",
  ordinal: 1 | 2 | 3 | 4 | 5 | 6 | 7
) {
  const metadata = role === "primary"
    ? { contractVersion: 21 as const, purpose: KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21 }
    : role === "scope"
      ? { contractVersion: 6 as const, purpose: KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION }
      : role === "scope_completeness"
        ? {
            contractVersion: 1 as const,
            purpose: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
          }
        : role === "initial"
          ? {
              contractVersion: 21 as const,
              purpose: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
            }
          : role === "scope_closure"
            ? {
                contractVersion: 2 as const,
                purpose: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_V2_OPERATION
              }
            : role === "supplement"
              ? {
                  contractVersion: 21 as const,
                  purpose: KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
                }
              : {
                  contractVersion: 21 as const,
                  purpose: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
                };
  return Object.freeze({
    acceptedRequestHash: hash,
    acceptedResultHash: role === "scope_completeness"
      ? completenessHash
      : role === "initial"
        ? selectorHash
        : role === "scope_closure"
          ? closureHash
          : hash,
    durationMs: 10,
    ...metadata,
    operationId: `operation-v52-${role.replaceAll("_", "-")}`,
    ordinal,
    providerRequestId: null,
    role,
    usage
  });
}

function input(): Parameters<typeof groundSettledKnowledgeAnswerV52>[0] {
  return {
    answerBindingFingerprint: hash,
    closure: {
      initialCoveredDimensionCount: 1,
      initialExcludedDimensionCount: 1,
      payloadHash: closureHash,
      reopenedCoveredDimensionCount: 0,
      reopenedDimensionCount: 1,
      reopenedExcludedDimensionCount: 1
    },
    completeness: {
      addedDimensionCount: 0,
      initialDimensionCount: 2,
      initialScopePayloadHash: hash,
      payloadHash: completenessHash
    },
    completenessRepairSucceeded: false,
    contracts: KNOWLEDGE_ANSWER_V21_CONTRACT_VERSIONS,
    coverage: {
      coveredDimensionCount: 1,
      excludedDimensionCount: 0,
      missingDimensionCount: 1,
      selectorPayloadHash: selectorHash
    },
    coverageScope: { dimensionCount: 2, payloadHash: hash },
    draftClaimCount: 2,
    evidence: evidence(),
    evidenceReceiptHash: hash,
    executionPolicy,
    executionPolicyFingerprint: knowledgeAnswerHash(executionPolicy),
    modelPinFingerprint: hash,
    operations: [
      operation("primary", 1),
      operation("scope", 2),
      operation("scope_completeness", 3),
      operation("initial", 4),
      operation("scope_closure", 5),
      operation("supplement", 6),
      operation("final", 7)
    ],
    providerPinFingerprint: hash,
    scopeRepairSucceeded: false,
    selectorRepairSucceeded: false,
    settlement: {
      contradictedClaimCount: 0,
      fallbackReason: null,
      finalText: "Corrected collective answer. [K1]",
      finalizationMode: "selected_claims",
      groundingStatus: "verified",
      outcome: "answered",
      requestCoverage: "complete",
      supportedClaimCount: 2,
      unsupportedClaimCount: 0
    }
  };
}

describe("Grounding Evidence V52", () => {
  it("attests an excluded-to-missing closure reopen without content", () => {
    const grounded = groundSettledKnowledgeAnswerV52(input());
    expect(grounded).toMatchObject({
      closure: {
        initialCoveredDimensionCount: 1,
        initialExcludedDimensionCount: 1,
        reopenedCoveredDimensionCount: 0,
        reopenedDimensionCount: 1,
        reopenedExcludedDimensionCount: 1,
        status: "accepted"
      },
      version: 52
    });
    expect(grounded.operations[4]).toMatchObject({
      contractVersion: 2,
      purpose: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_V2_OPERATION
    });
    expect(JSON.stringify(grounded)).not.toContain("Question");
    expect(JSON.stringify(grounded)).not.toContain("Evidence");
  });

  it("rejects inconsistent transition counters and historical closure purpose drift", () => {
    const valid = input();
    expect(() => groundSettledKnowledgeAnswerV52({
      ...valid,
      closure: { ...valid.closure!, reopenedDimensionCount: 0 }
    })).toThrow(KnowledgeAnswerContractError);
    expect(() => groundSettledKnowledgeAnswerV52({
      ...valid,
      operations: valid.operations.map((item) => item.role === "scope_closure"
        ? {
            ...item,
            contractVersion: 1,
            purpose: "knowledge_coverage_scope_closure_v1"
          }
        : item) as typeof valid.operations
    })).toThrow(KnowledgeAnswerContractError);
  });

  it("keeps historical V52 from acquiring all-excluded admission semantics", () => {
    const candidate = input();
    expect(() => groundSettledKnowledgeAnswerV52({
      ...candidate,
      closure: {
        initialCoveredDimensionCount: 0,
        initialExcludedDimensionCount: 2,
        payloadHash: closureHash,
        reopenedCoveredDimensionCount: 0,
        reopenedDimensionCount: 2,
        reopenedExcludedDimensionCount: 2
      },
      coverage: {
        ...candidate.coverage,
        coveredDimensionCount: 0,
        excludedDimensionCount: 0,
        missingDimensionCount: 2
      }
    })).toThrow(KnowledgeAnswerContractError);
  });
});

describe("Grounding Evidence V53", () => {
  it("attests an all-excluded closure admission without private content", () => {
    const candidate = input();
    const grounded = groundSettledKnowledgeAnswerV53({
      ...candidate,
      closure: {
        initialCoveredDimensionCount: 0,
        initialExcludedDimensionCount: 2,
        payloadHash: closureHash,
        reopenedCoveredDimensionCount: 0,
        reopenedDimensionCount: 2,
        reopenedExcludedDimensionCount: 2
      },
      coverage: {
        ...candidate.coverage,
        coveredDimensionCount: 0,
        excludedDimensionCount: 0,
        missingDimensionCount: 2
      }
    });
    expect(grounded).toMatchObject({
      closure: {
        initialCoveredDimensionCount: 0,
        initialExcludedDimensionCount: 2,
        reopenedCoveredDimensionCount: 0,
        reopenedDimensionCount: 2,
        reopenedExcludedDimensionCount: 2,
        status: "accepted"
      },
      version: 53
    });
    expect(JSON.stringify(grounded)).not.toContain("Question");
    expect(JSON.stringify(grounded)).not.toContain("Evidence");
  });

  it("rejects a missing closure receipt while an excluded reduction survives", () => {
    const candidate = input();
    expect(() => groundSettledKnowledgeAnswerV53({
      ...candidate,
      closure: null,
      coverage: {
        ...candidate.coverage,
        coveredDimensionCount: 0,
        excludedDimensionCount: 1,
        missingDimensionCount: 1
      },
      operations: candidate.operations.filter(({ role }) =>
        role !== "scope_closure").map((operation, index) => ({
          ...operation,
          ordinal: index + 1 as 1 | 2 | 3 | 4 | 5 | 6
        }))
    })).toThrow(KnowledgeAnswerContractError);
  });
});

describe("Grounding Evidence V54", () => {
  it("persists only the bounded cross-target repeat count", () => {
    const grounded = groundSettledKnowledgeAnswerV54({
      ...input(),
      crossTargetExactRepeatCount: 1
    });
    expect(grounded).toMatchObject({
      crossTargetExactRepeatCount: 1,
      version: 54
    });
    expect(JSON.stringify(grounded)).not.toContain("Question");
    expect(JSON.stringify(grounded)).not.toContain("Evidence");
  });

  it("rejects an unbounded count or a positive count without Supplement", () => {
    expect(() => groundSettledKnowledgeAnswerV54({
      ...input(),
      crossTargetExactRepeatCount: 23
    })).toThrow(KnowledgeAnswerContractError);
    const withoutSupplement = input();
    expect(() => groundSettledKnowledgeAnswerV54({
      ...withoutSupplement,
      crossTargetExactRepeatCount: 1,
      operations: withoutSupplement.operations.filter(({ role }) => role !== "supplement")
    })).toThrow(KnowledgeAnswerContractError);
  });
});

describe("Grounding Evidence V55", () => {
  it("versions the quality-ranked prompt without widening the receipt", () => {
    const grounded = groundSettledKnowledgeAnswerV55({
      ...input(),
      crossTargetExactRepeatCount: 1
    });
    expect(grounded).toMatchObject({
      crossTargetExactRepeatCount: 1,
      version: 55
    });
    expect(JSON.stringify(grounded)).not.toContain("Question");
    expect(JSON.stringify(grounded)).not.toContain("Evidence");
  });
});
