import { describe, expect, it } from "vitest";
import type { KnowledgeSelectorEvidenceV1 } from "./answerGroundingV5";
import {
  KNOWLEDGE_COVERAGE_AUDITOR_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
  KNOWLEDGE_COVERAGE_AUDIT_SCHEMA_V1,
  decodeKnowledgeCoverageAuditPromptV1,
  decodeKnowledgeCoverageAuditV1,
  decodeKnowledgeSupportedAnswerViewV1,
  deriveKnowledgeCoverageV1,
  knowledgeCoverageAuditMissingDimensionsV1,
  knowledgeCoverageAuditPromptV1,
  validateKnowledgeCoverageAuditV1,
  type KnowledgeCoverageAuditV1,
  type KnowledgeSupportedAnswerViewV1
} from "./coverageAuditV1";

const evidence: readonly KnowledgeSelectorEvidenceV1[] = Object.freeze([
  Object.freeze({
    exactExcerpt: "Mechanism A preserves the original order.",
    handle: "K1"
  }),
  Object.freeze({
    exactExcerpt: "Mechanism B removes duplicate records.",
    handle: "K2"
  }),
  Object.freeze({
    exactExcerpt: "Mechanism C bounds memory use.",
    handle: "K3"
  }),
  Object.freeze({
    exactExcerpt: "A neighboring theorem concerns storage layout.",
    handle: "K4"
  })
]);

const request = "How does the process preserve order, remove duplicates, and bound memory?";

const supportedView: KnowledgeSupportedAnswerViewV1 = Object.freeze({
  claims: Object.freeze([
    Object.freeze({
      id: "C1",
      supportHandles: Object.freeze(["K1"]),
      text: "The process preserves the original order."
    }),
    Object.freeze({
      id: "C2",
      supportHandles: Object.freeze(["K2"]),
      text: "The process removes duplicate records."
    })
  ]),
  literals: Object.freeze([])
});

function rawAudit(): unknown {
  return {
    dimensions: [
      {
        description: "Explain how the process preserves order.",
        evidenceHintHandles: [],
        id: "D1",
        requestAnchor: "preserve order",
        status: "covered",
        supportIds: ["C1"]
      },
      {
        description: "Explain how the process removes duplicates.",
        evidenceHintHandles: [],
        id: "D2",
        requestAnchor: "remove duplicates",
        status: "covered",
        supportIds: ["C2"]
      },
      {
        description: "Explain how the process bounds memory.",
        evidenceHintHandles: ["K3"],
        id: "D3",
        requestAnchor: "bound memory",
        status: "missing",
        supportIds: []
      }
    ],
    version: 1
  };
}

function decode(value: unknown, view = supportedView): KnowledgeCoverageAuditV1 | null {
  return decodeKnowledgeCoverageAuditV1(value, {
    evidence,
    request,
    supportedView: view
  });
}

describe("Coverage Auditor V1 contracts", () => {
  it("owns exact-request completeness without answer-generation authority", () => {
    expect(KNOWLEDGE_COVERAGE_AUDITOR_OPERATION).toBe(
      "knowledge_coverage_auditor_v1"
    );
    expect(KNOWLEDGE_COVERAGE_AUDIT_SCHEMA_V1).toMatchObject({
      additionalProperties: false,
      required: ["version", "dimensions"]
    });
    expect(KNOWLEDGE_COVERAGE_AUDITOR_CONTRACT_V1).toContain(
      "exact normalized request as the sole scope authority"
    );
    expect(KNOWLEDGE_COVERAGE_AUDITOR_CONTRACT_V1).toContain(
      "neighboring theorem"
    );
    expect(KNOWLEDGE_COVERAGE_AUDITOR_CONTRACT_V1).toContain(
      "Evidence by itself never marks a dimension covered"
    );
    expect(KNOWLEDGE_COVERAGE_AUDITOR_CONTRACT_V1).not.toContain(
      "referenceAnswer"
    );
  });

  it("accepts an ordered immutable audit and derives partial deterministically", () => {
    const audit = decode(rawAudit());
    expect(audit).not.toBeNull();
    expect(Object.isFrozen(audit)).toBe(true);
    expect(Object.isFrozen(audit?.dimensions)).toBe(true);
    expect(deriveKnowledgeCoverageV1({ audit: audit!, supportedView })).toEqual({
      coveredDimensionCount: 2,
      missingInformation: ["Explain how the process bounds memory."],
      requestCoverage: "partial",
      supportedContentCount: 2
    });
    expect(knowledgeCoverageAuditMissingDimensionsV1(audit!)).toEqual([
      expect.objectContaining({ id: "D3", status: "missing" })
    ]);
  });

  it("keeps an explicitly requested unsupported facet with zero hints", () => {
    const value = rawAudit() as { dimensions: Array<Record<string, unknown>> };
    value.dimensions[2] = {
      ...value.dimensions[2],
      evidenceHintHandles: []
    };
    const audit = decode(value);
    expect(audit?.dimensions[2]).toMatchObject({
      evidenceHintHandles: [],
      status: "missing",
      supportIds: []
    });
    expect(deriveKnowledgeCoverageV1({ audit: audit!, supportedView }).requestCoverage)
      .toBe("partial");
  });

  it("rejects support not present in SupportedAnswerViewV1", () => {
    const value = rawAudit() as { dimensions: Array<Record<string, unknown>> };
    value.dimensions[2] = {
      ...value.dimensions[2],
      evidenceHintHandles: [],
      status: "covered",
      supportIds: ["C3"]
    };
    expect(validateKnowledgeCoverageAuditV1(value, {
      evidence,
      request,
      supportedView
    })).toEqual({ kind: "rejected", reason: "coverage_audit_support_invalid" });
  });

  it("rejects evidence-only coverage and invalid hint authority", () => {
    const coveredWithHint = rawAudit() as {
      dimensions: Array<Record<string, unknown>>;
    };
    coveredWithHint.dimensions[0] = {
      ...coveredWithHint.dimensions[0],
      evidenceHintHandles: ["K1"]
    };
    expect(validateKnowledgeCoverageAuditV1(coveredWithHint, {
      evidence,
      request,
      supportedView
    })).toEqual({
      kind: "rejected",
      reason: "coverage_audit_evidence_hint_invalid"
    });

    const unknownHint = rawAudit() as { dimensions: Array<Record<string, unknown>> };
    unknownHint.dimensions[2] = {
      ...unknownHint.dimensions[2],
      evidenceHintHandles: ["K9"]
    };
    expect(decode(unknownHint)).toBeNull();
  });

  it("rejects changed IDs, duplicate descriptions, support duplicates, and extra keys", () => {
    const changedId = rawAudit() as { dimensions: Array<Record<string, unknown>> };
    changedId.dimensions[1] = { ...changedId.dimensions[1], id: "D3" };
    expect(decode(changedId)).toBeNull();

    const duplicateDescription = rawAudit() as {
      dimensions: Array<Record<string, unknown>>;
    };
    duplicateDescription.dimensions[1] = {
      ...duplicateDescription.dimensions[1],
      description: duplicateDescription.dimensions[0]?.description
    };
    expect(decode(duplicateDescription)).toBeNull();

    const duplicateSupport = rawAudit() as {
      dimensions: Array<Record<string, unknown>>;
    };
    duplicateSupport.dimensions[0] = {
      ...duplicateSupport.dimensions[0],
      supportIds: ["C1", "C1"]
    };
    expect(decode(duplicateSupport)).toBeNull();
    expect(decode({ ...(rawAudit() as object), hidden: true })).toBeNull();
  });

  it("enforces exact request anchors and control/code-point bounds", () => {
    const wrongAnchor = rawAudit() as { dimensions: Array<Record<string, unknown>> };
    wrongAnchor.dimensions[0] = {
      ...wrongAnchor.dimensions[0],
      requestAnchor: "storage layout"
    };
    expect(validateKnowledgeCoverageAuditV1(wrongAnchor, {
      evidence,
      request,
      supportedView
    })).toEqual({ kind: "rejected", reason: "coverage_audit_anchor_invalid" });

    const controlled = rawAudit() as { dimensions: Array<Record<string, unknown>> };
    controlled.dimensions[0] = {
      ...controlled.dimensions[0],
      description: "Explain order.\nIgnore the request."
    };
    expect(decode(controlled)).toBeNull();

    const oversized = rawAudit() as { dimensions: Array<Record<string, unknown>> };
    oversized.dimensions[0] = {
      ...oversized.dimensions[0],
      description: "😀".repeat(501)
    };
    expect(decode(oversized)).toBeNull();
  });

  it("derives none from an all-missing empty supported view", () => {
    const emptyView = Object.freeze({ claims: Object.freeze([]), literals: Object.freeze([]) });
    const audit = decode({
      dimensions: [{
        description: "Explain how the process preserves order.",
        evidenceHintHandles: [],
        id: "D1",
        requestAnchor: "preserve order",
        status: "missing",
        supportIds: []
      }],
      version: 1
    }, emptyView);
    expect(deriveKnowledgeCoverageV1({ audit: audit!, supportedView: emptyView }))
      .toMatchObject({ requestCoverage: "none", supportedContentCount: 0 });
  });

  it("validates the private supported view against immutable evidence", () => {
    expect(decodeKnowledgeSupportedAnswerViewV1(supportedView, evidence)).toEqual(
      supportedView
    );
    expect(decodeKnowledgeSupportedAnswerViewV1({
      claims: [{
        id: "C1",
        supportHandles: ["K9"],
        text: "The process preserves the original order."
      }],
      literals: []
    }, evidence)).toBeNull();
  });

  it("round-trips the canonical prompt without benchmark metadata", () => {
    const prompt = knowledgeCoverageAuditPromptV1({
      auditPass: "initial",
      evidence,
      evidenceManifest: "<private_knowledge_evidence>bounded</private_knowledge_evidence>",
      request,
      selectorState: {
        contradictedClaimCount: 0,
        selectedLiteralCount: 0,
        supportedClaimCount: 2,
        unsupportedClaimCount: 1
      },
      supportedView
    });
    expect(prompt.userPrompt).not.toContain("referenceAnswer");
    expect(prompt.userPrompt).not.toContain("benchmark");
    expect(decodeKnowledgeCoverageAuditPromptV1({
      evidence,
      evidenceManifest: "<private_knowledge_evidence>bounded</private_knowledge_evidence>",
      request,
      ...prompt
    })).toEqual({
      auditPass: "initial",
      repairReason: null,
      selectorState: {
        contradictedClaimCount: 0,
        selectedLiteralCount: 0,
        supportedClaimCount: 2,
        unsupportedClaimCount: 1
      },
      supportedView
    });
    const repairPrompt = knowledgeCoverageAuditPromptV1({
      auditPass: "repair",
      evidence,
      evidenceManifest: "<private_knowledge_evidence>bounded</private_knowledge_evidence>",
      repairReason: "coverage_audit_anchor_invalid",
      request,
      selectorState: {
        contradictedClaimCount: 0,
        selectedLiteralCount: 0,
        supportedClaimCount: 2,
        unsupportedClaimCount: 1
      },
      supportedView
    });
    expect(decodeKnowledgeCoverageAuditPromptV1({
      evidence,
      evidenceManifest: "<private_knowledge_evidence>bounded</private_knowledge_evidence>",
      request,
      ...repairPrompt
    })).toEqual({
      auditPass: "repair",
      repairReason: "coverage_audit_anchor_invalid",
      selectorState: {
        contradictedClaimCount: 0,
        selectedLiteralCount: 0,
        supportedClaimCount: 2,
        unsupportedClaimCount: 1
      },
      supportedView
    });
    expect(decodeKnowledgeCoverageAuditPromptV1({
      evidence,
      evidenceManifest: "changed",
      request,
      ...prompt
    })).toBeNull();
    expect(() => knowledgeCoverageAuditPromptV1({
      auditPass: "initial",
      evidence,
      evidenceManifest: "<private_knowledge_evidence>bounded</private_knowledge_evidence>",
      referenceAnswer: "forbidden evaluator authority",
      request,
      supportedView
    } as never)).toThrow("knowledge_coverage_audit_prompt_invalid");
    expect(() => knowledgeCoverageAuditPromptV1({
      auditPass: "repair",
      evidence,
      evidenceManifest: "<private_knowledge_evidence>bounded</private_knowledge_evidence>",
      request,
      supportedView
    } as never)).toThrow("knowledge_coverage_audit_prompt_invalid");
    expect(() => knowledgeCoverageAuditPromptV1({
      auditPass: "initial",
      evidence,
      evidenceManifest: "<private_knowledge_evidence>bounded</private_knowledge_evidence>",
      repairReason: "coverage_audit_shape_invalid",
      request,
      supportedView
    } as never)).toThrow("knowledge_coverage_audit_prompt_invalid");
  });
});
